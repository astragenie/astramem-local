import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';
import { HandlerRegistry } from '../../src/pipeline/registry.js';
import { startWorker } from '../../src/pipeline/worker.js';
import { defaultConfig } from '../../src/config/config.js';
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
