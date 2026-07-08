import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';
import { HandlerRegistry } from '../../src/pipeline/registry.js';
import { startWorker, resolveWorkerConcurrency } from '../../src/pipeline/worker.js';
import { defaultConfig } from '../../src/config/config.js';
import { DeterministicError, TransientError } from '../../src/pipeline/errors.js';
import type { DB } from '../../src/storage/db.js';
import type { JobHandler } from '../../src/pipeline/handler.js';

/** Helper: wait until a condition is true, polling every 20ms, up to maxMs. */
async function waitFor(pred: () => boolean, maxMs = 2000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > maxMs) throw new Error('waitFor timed out');
    await new Promise(r => setTimeout(r, 20));
  }
}

describe('Worker', () => {
  let db: DB;
  let repo: JobRepo;
  let registry: HandlerRegistry;
  let stopWorker: (() => void) | null = null;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new JobRepo(db);
    registry = new HandlerRegistry();
  });

  afterEach(() => {
    stopWorker?.();
    stopWorker = null;
  });

  it('processes a pending job to completed via a successful handler', async () => {
    const handler: JobHandler = {
      kind: 'cleanup',
      async handle(_payload, _ctx) {
        // no-op success
      }
    };
    registry.register(handler);

    const id = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'completed';
    });

    const job = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number;
    };
    expect(job.state).toBe('completed');
    expect(job.attempts).toBe(0);
  });

  it('increments attempts and records last_error on a throwing handler', async () => {
    // The handler throws once then succeeds — lets us observe attempts+last_error
    // without racing the requeue cycle.
    let callCount = 0;
    const handler: JobHandler = {
      kind: 'distill',
      async handle(_payload, _ctx) {
        callCount++;
        if (callCount === 1) throw new Error('handler boom');
        // second call succeeds
      }
    };
    registry.register(handler);

    const id = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    // Wait until the job completes (2nd attempt succeeds)
    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'completed';
    });

    const job = db.prepare('SELECT state, attempts, last_error FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number; last_error: string | null;
    };
    expect(job.state).toBe('completed');
    // attempts was incremented by the first failure
    expect(job.attempts).toBe(1);
    // last_error records the first failure message
    expect(job.last_error).toContain('handler boom');
  });

  it('marks job as poison after 3 failures', async () => {
    let callCount = 0;
    const handler: JobHandler = {
      kind: 'reembed',
      async handle(_payload, _ctx) {
        callCount++;
        throw new Error(`fail #${callCount}`);
      }
    };
    registry.register(handler);

    const id = repo.enqueue('reembed', { kind: 'reembed', memory_id: 'm1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'poison';
    }, 5000);

    const job = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number;
    };
    expect(job.state).toBe('poison');
    expect(job.attempts).toBe(3);
  });

  it('marks job as poison after 3 attempts when no handler is registered', async () => {
    // No handler registered for 'distill' — worker retries 3 times then poisons
    const id = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'poison';
    }, 5000);

    const job = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number;
    };
    expect(job.state).toBe('poison');
    expect(job.attempts).toBe(3);
  });

  it('poisons immediately on DeterministicError — no further retries', async () => {
    let callCount = 0;
    const handler: JobHandler = {
      kind: 'distill',
      async handle(_payload, _ctx) {
        callCount++;
        throw new DeterministicError('Zod parse failed: invalid_type at atoms[0].type');
      },
    };
    registry.register(handler);

    const id = repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'poison';
    }, 3000);

    const job = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number;
    };
    expect(job.state).toBe('poison');
    // Exactly one attempt — no retry budget wasted
    expect(job.attempts).toBe(1);
    expect(callCount).toBe(1);
  });

  it('retries up to MAX_ATTEMPTS on TransientError then poisons', async () => {
    let callCount = 0;
    const handler: JobHandler = {
      kind: 'reembed',
      async handle(_payload, _ctx) {
        callCount++;
        throw new TransientError(`ECONNREFUSED attempt ${callCount}`);
      },
    };
    registry.register(handler);

    const id = repo.enqueue('reembed', { kind: 'reembed', memory_id: 'm1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'poison';
    }, 10_000);

    const job = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number;
    };
    expect(job.state).toBe('poison');
    // Exhausted 3 transient retries
    expect(job.attempts).toBe(3);
    expect(callCount).toBe(3);
  });

  it('stop() halts the poll loop', async () => {
    let handlerCallCount = 0;
    const handler: JobHandler = {
      kind: 'cleanup',
      async handle(_payload, _ctx) {
        handlerCallCount++;
      }
    };
    registry.register(handler);

    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stop(); // stop before enqueuing

    const countBefore = handlerCallCount;
    repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });

    // Wait 200ms — the handler should NOT be called since worker is stopped
    await new Promise(r => setTimeout(r, 200));
    expect(handlerCallCount).toBe(countBefore);
  });
});

describe('resolveWorkerConcurrency', () => {
  it('defaults to 1 when pipeline.concurrency is 1 (default config)', () => {
    expect(resolveWorkerConcurrency(defaultConfig())).toBe(1);
  });

  it('passes through values within [1, 8]', () => {
    const cfg = { ...defaultConfig(), pipeline: { concurrency: 4 } };
    expect(resolveWorkerConcurrency(cfg)).toBe(4);
  });

  it('clamps values above 8 down to 8', () => {
    const cfg = { ...defaultConfig(), pipeline: { concurrency: 20 } };
    expect(resolveWorkerConcurrency(cfg)).toBe(8);
  });

  it('clamps values below 1 (zero, negative) up to 1', () => {
    expect(resolveWorkerConcurrency({ ...defaultConfig(), pipeline: { concurrency: 0 } })).toBe(1);
    expect(resolveWorkerConcurrency({ ...defaultConfig(), pipeline: { concurrency: -5 } })).toBe(1);
  });

  it('falls back to 1 for non-finite / non-numeric values rather than throwing', () => {
    expect(resolveWorkerConcurrency({ ...defaultConfig(), pipeline: { concurrency: NaN } })).toBe(1);
    expect(resolveWorkerConcurrency({
      ...defaultConfig(),
      // Simulates a malformed hand-edited config.yaml value surviving the loader.
      pipeline: { concurrency: 'four' as unknown as number },
    })).toBe(1);
  });

  it('truncates fractional values', () => {
    expect(resolveWorkerConcurrency({ ...defaultConfig(), pipeline: { concurrency: 3.9 } })).toBe(3);
  });
});

describe('Worker concurrency', () => {
  let db: DB;
  let repo: JobRepo;
  let registry: HandlerRegistry;
  let stopWorker: (() => void | Promise<void>) | null = null;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new JobRepo(db);
    registry = new HandlerRegistry();
  });

  afterEach(async () => {
    await stopWorker?.();
    stopWorker = null;
  });

  it('N=2 concurrency: two slow jobs overlap in execution (proven by timestamps)', async () => {
    const starts: number[] = [];
    const ends: number[] = [];
    const SLOW_MS = 150;

    const handler: JobHandler = {
      kind: 'cleanup',
      async handle(_payload, _ctx) {
        starts.push(Date.now());
        await new Promise((r) => setTimeout(r, SLOW_MS));
        ends.push(Date.now());
      },
    };
    registry.register(handler);

    const id1 = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    const id2 = repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });

    const config = { ...defaultConfig(), pipeline: { concurrency: 2 } };
    const { stop } = startWorker({ pollMs: 20, registry, db, config });
    stopWorker = stop;

    await waitFor(() => {
      const j1 = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id1) as { state: string } | undefined;
      const j2 = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id2) as { state: string } | undefined;
      return j1?.state === 'completed' && j2?.state === 'completed';
    }, 3000);

    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);

    // Overlap proof: the second job's start timestamp is strictly before the
    // first job's end timestamp — i.e. both were mid-flight at the same time.
    // Under the old single-lane worker this would be physically impossible
    // (job2 cannot even be claimed until job1 finishes and completes).
    const sortedStarts = [...starts].sort((a, b) => a - b);
    const sortedEnds = [...ends].sort((a, b) => a - b);
    expect(sortedStarts[1]).toBeLessThan(sortedEnds[0] as number);

    // Wall-clock proof: 2 sequential 150ms jobs would take >=300ms; running
    // concurrently they finish well under that.
    const totalWall = (sortedEnds[1] as number) - (sortedStarts[0] as number);
    expect(totalWall).toBeLessThan(SLOW_MS * 2);
  });

  it('claim-atomicity: N=6 concurrent lanes over 20 jobs — every job executes exactly once', async () => {
    const executionCounts = new Map<string, number>();
    const handler: JobHandler = {
      kind: 'cleanup',
      async handle(payload, _ctx) {
        const p = payload as { job_marker: string };
        executionCounts.set(p.job_marker, (executionCounts.get(p.job_marker) ?? 0) + 1);
        // Small random-ish delay so lanes genuinely interleave claims instead
        // of trivially serializing.
        await new Promise((r) => setTimeout(r, 5));
      },
    };
    registry.register(handler);

    const ids: string[] = [];
    const JOB_COUNT = 20;
    for (let i = 0; i < JOB_COUNT; i++) {
      ids.push(repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30, job_marker: `job-${i}` }));
    }

    const config = { ...defaultConfig(), pipeline: { concurrency: 6 } };
    const { stop } = startWorker({ pollMs: 10, registry, db, config });
    stopWorker = stop;

    await waitFor(() => {
      const rows = db.prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE id IN (${ids.map(() => '?').join(',')}) AND state = 'completed'`,
      ).get(...ids) as { n: number };
      return rows.n === JOB_COUNT;
    }, 5000);

    // Every job_marker executed exactly once — no double-claim, no dropped job.
    expect(executionCounts.size).toBe(JOB_COUNT);
    for (const count of executionCounts.values()) {
      expect(count).toBe(1);
    }
  });

  it('default concurrency (1) preserves strict FIFO execution order', async () => {
    const executionOrder: string[] = [];
    const handler: JobHandler = {
      kind: 'cleanup',
      async handle(payload, _ctx) {
        const p = payload as { job_marker: string };
        executionOrder.push(p.job_marker);
        await new Promise((r) => setTimeout(r, 10));
      },
    };
    registry.register(handler);

    const markers = ['first', 'second', 'third', 'fourth'];
    const ids = markers.map((m) =>
      repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30, job_marker: m }),
    );

    // No `pipeline` override — exercises the real default (concurrency: 1),
    // byte-identical to pre-concurrency single-lane behavior.
    const { stop } = startWorker({ pollMs: 20, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const rows = db.prepare(
        `SELECT COUNT(*) AS n FROM jobs WHERE id IN (${ids.map(() => '?').join(',')}) AND state = 'completed'`,
      ).get(...ids) as { n: number };
      return rows.n === markers.length;
    }, 5000);

    expect(executionOrder).toEqual(markers);
  });
});
