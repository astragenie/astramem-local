/**
 * FEAT-482: `consolidate` job handler — budget-cap wiring.
 *
 * Proves two things the original FEAT-456 SLICE-1 wiring never exercised:
 *  1. A `BudgetExceeded` thrown by the contradiction judge (mid-`runConsolidation`)
 *     is converted to `BudgetPausedError` here, EXACTLY mirroring
 *     pipeline/handlers/distill.ts's catch block — before this fix,
 *     consolidateHandler had no catch at all, so a cap hit would fall through
 *     to worker.ts's ordinary transient/deterministic classification (retries
 *     toward poison) instead of the intended pause-not-fail path.
 *  2. A job the worker paused on that error actually has a way back to
 *     'pending' — `astramem-local budget --reset` (src/cli/budget.ts) now
 *     also calls `JobRepo.requeuePaused()`. This path had never been
 *     exercised for ANY job kind before FEAT-482 (see job-recovery.test.ts's
 *     `requeuePaused` tests for the generic case) — this file proves it
 *     end-to-end through the real consolidateHandler.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../../src/storage/db.js';
import { migrate } from '../../../src/storage/migrate.js';
import { MemoryRepo } from '../../../src/storage/memories.js';
import { SqliteVecStore } from '../../../src/vector/sqlite-vec.js';
import { JobRepo } from '../../../src/pipeline/job-repo.js';
import { consolidateHandler } from '../../../src/pipeline/handlers/consolidate.js';
import { BudgetPausedError } from '../../../src/pipeline/errors.js';
import { BudgetTracker } from '../../../src/budget/tracker.js';
import { defaultConfig } from '../../../src/config/config.js';
import { makeMockProviders } from '../../../src/pipeline/mock-providers.js';
import type { ExtendedHandlerCtx } from '../../../src/pipeline/handler-ctx-ext.js';

/** Unit vector with all mass on one axis, tilted toward a second axis by `tilt` — mirrors consolidate.test.ts's helper. */
function vecAt(axis: number, tilt = 0, tiltAxis = 1): Float32Array {
  const v = new Float32Array(1024);
  v[axis] = 1;
  if (tilt > 0) v[tiltAxis] = tilt;
  return v;
}

async function seedEmbedded(db: DB, text: string, hash: string, vec: Float32Array): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
  await new SqliteVecStore(db).upsert(id, vec);
  return id;
}

describe('consolidateHandler — FEAT-482 budget wiring', () => {
  let db: DB;
  let ctx: ExtendedHandlerCtx;
  let jobRepo: JobRepo;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    jobRepo = new JobRepo(db);
    ctx = {
      db,
      config: {
        ...defaultConfig(),
        budget: { daily_usd: 1 },
        consolidation: {
          ...defaultConfig().consolidation,
          contradictionDetection: {
            mode: 'enabled', minSimilarity: 0.6, minConfidence: 0.7, maxPerRun: 200, maxWallClockMs: 60_000,
          },
        },
      },
      providers: makeMockProviders(),
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };

    // Mock judge vocabulary pair P2 (src/consolidate/mock-judge-pairs.ts):
    // 'Default port is 7777.' vs 'Default port is now 8888.' -> contradicts,
    // confidence 0.92. Propose-tier similarity (well below mergeThreshold,
    // above the judge's minSimilarity), so it's judge-eligible.
    const older = await seedEmbedded(db, 'Default port is 7777.', 'h-a', vecAt(0));
    const newer = await seedEmbedded(db, 'Default port is now 8888.', 'h-b', vecAt(0, 1.02));
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(1_000, older);
    db.prepare('UPDATE memories SET created_at = ? WHERE id = ?').run(2_000, newer);
  });

  it('converts a BudgetExceeded from the judge into BudgetPausedError, mirroring distillHandler', async () => {
    new BudgetTracker(db).record(1); // cap already fully spent before the run starts
    await expect(consolidateHandler.handle({}, ctx)).rejects.toThrow(BudgetPausedError);
  });

  it('a paused consolidate job resumes (state -> pending) after budget --reset, and a fresh run then succeeds', async () => {
    const tracker = new BudgetTracker(db);
    tracker.record(1); // cap exhausted

    const jobId = jobRepo.enqueue('consolidate', {});
    jobRepo.claimPending(); // pending -> running, mirrors what the worker does before calling handle()

    // Exercise the handler directly — this is the exact conversion worker.ts
    // relies on (its `BudgetPausedError.is(err)` check) to route to pause()
    // instead of fail(). We drive that same catch block here without
    // needing the full startWorker poll loop.
    await expect(consolidateHandler.handle({}, ctx)).rejects.toThrow(BudgetPausedError);

    // Simulate worker.ts's catch block: pause, not fail — attempts untouched.
    jobRepo.pause(jobId);
    expect(jobRepo.get(jobId)?.state).toBe('paused');
    expect(jobRepo.get(jobId)?.attempts).toBe(0);

    // `astramem-local budget --reset` (src/cli/budget.ts): resets today's
    // spend AND requeues paused jobs (FEAT-482 fix — before it, --reset only
    // did the first half and this job would stay 'paused' forever).
    tracker.resetToday();
    const requeued = jobRepo.requeuePaused();

    expect(requeued).toBe(1);
    expect(jobRepo.get(jobId)?.state).toBe('pending');

    // And the underlying condition is actually cleared, not just the job
    // state: a fresh handler invocation now succeeds instead of pausing
    // again, because the daily spend really is back at $0.
    await expect(consolidateHandler.handle({}, ctx)).resolves.toBeUndefined();
  });

  it('non-budget errors are NOT converted to BudgetPausedError and propagate as-is', async () => {
    // A malformed payload throws a plain ZodError from ConsolidatePayloadSchema.parse —
    // must NOT be swallowed into a false "budget paused" pause.
    let caught: unknown;
    try {
      await consolidateHandler.handle({ merge_threshold: 'not-a-number' }, ctx);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught).not.toBeInstanceOf(BudgetPausedError);
  });
});
