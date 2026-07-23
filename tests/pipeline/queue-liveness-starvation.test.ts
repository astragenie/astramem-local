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
 * shipped as mitigations. `startWorker`'s lanes were originally fully
 * generic — `JobRepo.claimPending()` claimed the oldest PENDING job
 * regardless of kind (see job-repo.ts / registry.ts) — with no priority
 * distinction that kept a slow `consolidate` job from being claimed ahead of
 * queued `distill` work.
 *
 * FEAT-482 fold (worker-starvation wave, 2026-07): `JobRepo` now stamps a
 * priority TIER per `JobKind` at enqueue time (`distill`/`distill-events` =
 * P1, `consolidate` = P3 — see job-repo.ts's `JOB_PRIORITY`) and
 * `claimPending()`'s ORDER BY honors it. That closes EXACTLY the scenario
 * this test reproduces: consolidate enqueued first, 5 distill jobs enqueued
 * after it, single lane. Before the fold, oldest-first FIFO meant the sole
 * lane claimed the already-pending `consolidate` job first and stayed
 * wedged on it for its whole ~800ms run, starving every distill job for the
 * entire liveness window — which is why this used to be `it.fails()`. Now
 * the lane's first (and every subsequent) claim prefers the higher-tier
 * pending distill jobs over the lower-tier consolidate job, so all 5
 * distill jobs drain before the sole consolidate job is ever claimed at all.
 * The test body now genuinely passes, so `it.fails()` was removed per its
 * own prior instruction ("a passing body under it.fails() is itself a
 * vitest failure").
 *
 * Residual gap this fold does NOT close (out of scope for priority tiers
 * alone, and inherent to a single-threaded synchronous worker without true
 * preemption): if a `consolidate` job is ALREADY claimed and running
 * (state='running', not 'pending') when a burst of higher-priority distill
 * jobs arrives, priority ordering cannot help — `claimPending()` only
 * chooses among PENDING rows, so an in-flight handler still runs to
 * completion before that lane claims again. That is a distinct hazard from
 * the one this test reproduces (both-pending-at-claim-time) and would need
 * genuine preemption or a dedicated non-monopolizable lane for consolidate
 * specifically to close.
 */
describe('Queue-liveness starvation canary (FEAT-483 SLICE-3, coupled to FEAT-482)', () => {
  let db: DB | null = null;
  let stopWorker: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await stopWorker?.();
    stopWorker = null;
    db = null;
  });

  it(
    'distill jobs still make progress while a long consolidation job runs — FEAT-482: priority tiers un-xfail this',
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

      // Enqueue order (consolidate first, distill after) is now the OPPOSITE
      // of what determines claim order: JobRepo.claimPending() orders by
      // priority tier first (distill=P1, consolidate=P3 — job-repo.ts's
      // JOB_PRIORITY), created_at only as a tiebreak within the same tier.
      // The single lane claims a distill job first despite consolidate
      // being older and already pending.
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

      // Liveness invariant this canary guards: distill throughput stays > 0
      // even with a consolidate job also pending, i.e. `running`/`completed`
      // doesn't stay pinned at 0 while `pending` > 0. With priority tiers,
      // the sole lane drains all 5 higher-tier distill jobs (near-instant
      // no-op handlers) before ever claiming the lower-tier consolidate job,
      // so distillCompletions reaches 5 and none are left 'pending' well
      // within the liveness window.
      expect(distillCompletions).toBeGreaterThan(0);
      expect(stillPending.n).toBeLessThan(distillIds.length);
    },
  );
});
