import { describe, it, expect, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';
import { HandlerRegistry } from '../../src/pipeline/registry.js';
import { startWorker } from '../../src/pipeline/worker.js';
import { defaultConfig } from '../../src/config/config.js';
import type { DB } from '../../src/storage/db.js';

/**
 * Queue-liveness starvation canary (FEAT-483 SLICE-3, coupled to FEAT-482).
 *
 * The FEAT-482 incident: the contradiction judge (a `consolidate` job) fired
 * ~245 sequential LLM calls against a metered endpoint and wedged the
 * daemon's worker lane for 10+ minutes — distill jobs sat at 32 pending / 0
 * running the whole time. `maxPerRun`/`maxWallClockMs` caps (config.ts) and
 * raising the default lane count 1 -> 2 (worker.ts / worker.test.ts) both
 * shipped as mitigations, but neither is a fix for the underlying hazard:
 * `startWorker`'s lanes are generic — `JobRepo.claimPending()` claims the
 * oldest PENDING job regardless of kind (see job-repo.ts / registry.ts).
 * There is no lane reservation or batching that keeps a slow `consolidate`
 * job from occupying a lane that `distill` jobs could otherwise use. On a
 * single-lane deployment (`pipeline.concurrency: 1` — still a supported,
 * documented config value; see resolveWorkerConcurrency's MIN_CONCURRENCY),
 * or wherever every lane happens to be busy, a long consolidation run
 * genuinely starves the queue: no other job can even be *claimed* until the
 * occupied lane's tick promise resolves, because worker.ts's per-lane
 * `launchTick`/`scheduleNext` only schedules that lane's next claim after
 * the current `handler.handle()` call returns (see worker.ts's tick()).
 * Each individual `await` inside the slow handler yields the event loop to
 * OTHER lanes, but not to itself, and not to a single, monopolized lane.
 *
 * This is a deliberate, deterministic reproduction — not a timing-flaky one:
 * with `concurrency: 1` there is structurally only one lane, so it is
 * physically impossible for a distill job to be claimed while that lane's
 * in-flight consolidate handler promise is still pending, no matter how the
 * scheduler jitters. That determinism is why this is `it.fails()` (a
 * genuine, reproducible expected-failure) rather than `it.skip` (which would
 * be the right call only if starvation were timing-dependent/flaky).
 *
 * The root-cause fix — consolidation must not be able to monopolize a lane
 * that queued distill jobs need (batching / per-kind lane isolation) — is
 * FEAT-482 follow-up work and has NOT landed. Until it does, this test's
 * body genuinely fails (distill throughput is pinned at 0 for the whole
 * liveness window while a consolidate job is running), which is exactly
 * what `it.fails()` expects. Once the lane-isolation fix lands, this test's
 * assertions will start passing and `it.fails()` must be removed (a passing
 * body under `it.fails()` is itself a vitest failure) — that flip is the
 * signal to close FEAT-482.
 */
describe('Queue-liveness starvation canary (FEAT-483 SLICE-3, coupled to FEAT-482)', () => {
  let db: DB | null = null;
  let stopWorker: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await stopWorker?.();
    stopWorker = null;
    db = null;
  });

  it.fails(
    'distill jobs still make progress while a long consolidation job runs — FEAT-482: un-xfail once worker-lane starvation is fixed',
    async () => {
      db = openDb(':memory:');
      migrate(db);
      const repo = new JobRepo(db);
      const registry = new HandlerRegistry();

      // Models the incident: a `consolidate` job that makes many sequential
      // awaited "LLM calls" (each one yields the event loop, but the
      // handler's own promise stays pending across all of them).
      const CONSOLIDATE_CALLS = 20;
      const CALL_DELAY_MS = 40; // ~800ms total handler runtime
      registry.register({
        kind: 'consolidate',
        async handle(): Promise<void> {
          for (let i = 0; i < CONSOLIDATE_CALLS; i++) {
            await new Promise((r) => setTimeout(r, CALL_DELAY_MS));
          }
        },
      });

      let distillCompletions = 0;
      registry.register({
        kind: 'distill',
        async handle(): Promise<void> {
          distillCompletions++;
        },
      });

      // Enqueue order matters: consolidate first, so the single lane's FIFO
      // claim (JobRepo.claimPending orders by created_at ASC) picks it up
      // before any distill job gets a chance to be claimed.
      repo.enqueue('consolidate', {});
      const distillIds = Array.from({ length: 5 }, () =>
        repo.enqueue('distill', { transcript_id: 't1', session_id: 's1' }),
      );

      // The single-lane worst case the AC describes ("the single worker
      // lane") — explicit override, same pattern worker.test.ts uses to
      // exercise concurrency: 1 now that the config default is 2.
      const cfg = { ...defaultConfig(), pipeline: { concurrency: 1 } };
      const { stop } = startWorker({ pollMs: 20, registry, db, config: cfg });
      stopWorker = stop;

      // Liveness window: comfortably shorter than the consolidate job's
      // total runtime (CONSOLIDATE_CALLS * CALL_DELAY_MS = 800ms) but long
      // enough that a queue with any spare liveness would have completed at
      // least one of the 5 queued distill jobs by now.
      const LIVENESS_WINDOW_MS = 300;
      await new Promise((r) => setTimeout(r, LIVENESS_WINDOW_MS));

      const stillPending = db
        .prepare(
          `SELECT COUNT(*) AS n FROM jobs WHERE id IN (${distillIds.map(() => '?').join(',')}) AND state = 'pending'`,
        )
        .get(...distillIds) as { n: number };

      // Desired liveness invariant (currently FALSE — the bug this canary
      // guards against): distill throughput stays > 0 even while a
      // consolidation job is running, i.e. `running`/`completed` doesn't
      // stay pinned at 0 while `pending` > 0. Today, with a consolidate job
      // occupying the sole lane, distillCompletions is 0 and all 5 distill
      // jobs are still 'pending' — the queue is completely wedged.
      expect(distillCompletions).toBeGreaterThan(0);
      expect(stillPending.n).toBeLessThan(distillIds.length);
    },
  );
});
