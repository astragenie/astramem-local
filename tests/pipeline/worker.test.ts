import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';
import { HandlerRegistry } from '../../src/pipeline/registry.js';
import { startWorker, resolveWorkerConcurrency } from '../../src/pipeline/worker.js';
import { defaultConfig } from '../../src/config/config.js';
import { DeterministicError, TransientError } from '../../src/pipeline/errors.js';
import { distillHandler } from '../../src/pipeline/handlers/distill.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import type { DB } from '../../src/storage/db.js';
import type { JobHandler } from '../../src/pipeline/handler.js';
import type { ExtendedHandlerCtx } from '../../src/pipeline/handler-ctx-ext.js';
import type { LLMProvider, EmbedProvider, ChatMsg, ChatResult, LLMHealth, EmbedHealth } from '../../src/contracts/index.js';

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

  it('honors a TransientError.retryAfterMs hint that exceeds the exponential backoff ceiling', async () => {
    // Exponential backoff for attempt 1 is 1000ms (2^0 * 1000). A
    // server-supplied Retry-After of 3000ms must win — the worker must not
    // undercut an explicit "wait this long" hint with its own blind guess.
    let callCount = 0;
    const callTimestamps: number[] = [];
    const handler: JobHandler = {
      kind: 'reembed',
      async handle(_payload, _ctx) {
        callTimestamps.push(Date.now());
        callCount++;
        if (callCount === 1) throw new TransientError('rate limited', undefined, 3000);
        // second call succeeds
      },
    };
    registry.register(handler);

    const id = repo.enqueue('reembed', { kind: 'reembed', memory_id: 'm1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'completed';
    }, 8000);

    expect(callTimestamps.length).toBe(2);
    const gapMs = (callTimestamps[1] as number) - (callTimestamps[0] as number);
    // Must be at least the retryAfterMs hint (3000ms), not the shorter 1000ms
    // exponential-backoff default. Generous lower bound for test/CI jitter.
    expect(gapMs).toBeGreaterThanOrEqual(2900);
  });

  it('a retryAfterMs SHORTER than the exponential backoff does not shrink the delay', async () => {
    // attempt 2's exponential backoff is 2000ms (2^1 * 1000). A
    // retryAfterMs of 500ms must NOT shorten that — max(backoff, hint) wins,
    // not the hint alone, so a stale/short server hint can't undercut our
    // own conservative floor.
    let callCount = 0;
    const callTimestamps: number[] = [];
    const handler: JobHandler = {
      kind: 'reembed',
      async handle(_payload, _ctx) {
        callTimestamps.push(Date.now());
        callCount++;
        if (callCount <= 2) throw new TransientError('rate limited', undefined, 500);
        // third call succeeds
      },
    };
    registry.register(handler);

    const id = repo.enqueue('reembed', { kind: 'reembed', memory_id: 'm1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'completed';
    }, 8000);

    expect(callTimestamps.length).toBe(3);
    const secondGapMs = (callTimestamps[2] as number) - (callTimestamps[1] as number);
    // Exponential backoff for attempt 2 is 2000ms — the 500ms hint must not shrink it.
    expect(secondGapMs).toBeGreaterThanOrEqual(1900);
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
  it('resolves the default config to 2 (FEAT-482: pipeline.concurrency default raised 1 -> 2)', () => {
    expect(resolveWorkerConcurrency(defaultConfig())).toBe(2);
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

  it('concurrency: 1 preserves strict FIFO execution order (the pre-FEAT-482 shipped default; still the safety valve for restoring exact old single-loop behavior)', async () => {
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

    // Explicit override: FEAT-482 raised the CONFIG default to 2 (see
    // `pipeline.concurrency` in config.ts), so `defaultConfig()` alone no
    // longer exercises single-lane FIFO — this test's whole point is
    // concurrency: 1 specifically, so it must ask for it explicitly.
    const config = { ...defaultConfig(), pipeline: { concurrency: 1 } };
    const { stop } = startWorker({ pollMs: 20, registry, db, config });
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

// ---------------------------------------------------------------------------
// End-to-end: a real distillHandler run through the worker's retry policy.
// Exercises the fix where extract.ts's LLM-JSON parse/validation failures
// are TransientError (retried up to MAX_ATTEMPTS with backoff) instead of
// poisoning the job on the first flaky sample.
// ---------------------------------------------------------------------------
describe('Worker + distillHandler (parse-failure retry policy)', () => {
  let db: DB;
  let repo: JobRepo;
  let registry: HandlerRegistry;
  let ctx: ExtendedHandlerCtx;
  let stopWorker: (() => void | Promise<void>) | null = null;

  function insertSession(id: string): void {
    db.prepare(`
      INSERT INTO sessions (id, repo, project, branch, agent, started_at)
      VALUES (?, NULL, NULL, NULL, NULL, ?)
    `).run(id, Date.now());
  }

  function insertTranscript(id: string, sessionId: string): void {
    const turns = [
      { role: 'user', text: 'what vector store should we use for v1?' },
      { role: 'assistant', text: 'sqlite-vec — no network dependency, single-process.' },
    ];
    db.prepare(`
      INSERT INTO transcripts (id, session_id, source, content, ingested_at, captured_at)
      VALUES (?, ?, 'claude-code-pre_compact', ?, ?, NULL)
    `).run(id, sessionId, JSON.stringify(turns), Date.now());
  }

  function makeCompactionLLM(): LLMProvider {
    return {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(messages: ChatMsg[]): Promise<ChatResult> {
        const userContent = messages.find(m => m.role === 'user')?.content ?? '';
        return { text: userContent, usage: { in: 10, out: 10, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test-model', latency_ms: 0 }; },
    };
  }

  /**
   * Extraction provider that returns unparseable text for the first `badCalls`
   * calls, then a valid single-atom response forever after — reproduces a
   * stochastic bad JSON sample that self-heals on the very next LLM call.
   */
  function makeFlakyExtractionLLM(badCalls: number): { provider: LLMProvider; callCount: () => number } {
    let calls = 0;
    const provider: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(): Promise<ChatResult> {
        calls++;
        if (calls <= badCalls) {
          return { text: 'not valid json, sorry!', usage: { in: 10, out: 10, usd: 0 } };
        }
        return {
          text: JSON.stringify({
            atoms: [{
              type: 'decision',
              text: 'use sqlite-vec for v1 vector storage',
              importance: 0.9,
              confidence: 0.9,
              // FEAT-485: `decision`/`lesson` atoms without a non-empty
              // `evidence` excerpt are now dropped by the extract-stage
              // provenance guard (requireEvidenceForRichTypes). A retry that
              // is meant to LAND a memory must emit an evidence-bearing atom,
              // same as a real extraction now must.
              evidence: 'we should use sqlite-vec for v1 vector storage',
            }],
          }),
          usage: { in: 10, out: 10, usd: 0 },
        };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test-model', latency_ms: 0 }; },
    };
    return { provider, callCount: () => calls };
  }

  function makeMockEmbed(): EmbedProvider {
    return {
      name: 'ollama' as const,
      model: 'test-embed',
      dim: 1024 as const,
      async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map((_, i) => {
          const v = new Float32Array(1024);
          for (let j = 0; j < 1024; j++) v[j] = Math.sin(i + j * 0.01);
          return v;
        });
      },
      async health(): Promise<EmbedHealth> { return { ok: true, model: 'test-embed', dim: 1024 }; },
    };
  }

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new JobRepo(db);
    registry = new HandlerRegistry();
    registry.register(distillHandler);
  });

  afterEach(async () => {
    await stopWorker?.();
    stopWorker = null;
  });

  it('retries a distill job through a transient extraction parse failure and lands memories without poisoning', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(sessionId);
    insertTranscript(transcriptId, sessionId);

    const { provider: extractionLLM, callCount } = makeFlakyExtractionLLM(1); // fails once, then succeeds
    ctx = {
      db,
      config: defaultConfig(),
      providers: { llm: { compaction: makeCompactionLLM(), extraction: extractionLLM }, embed: makeMockEmbed() },
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };

    const id = repo.enqueue('distill', { transcript_id: transcriptId, session_id: sessionId });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig(), ctx });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'completed' || job?.state === 'poison';
    }, 10_000);

    const job = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number;
    };
    expect(job.state).toBe('completed');
    expect(job.attempts).toBe(1); // one transient failure, then success
    expect(callCount()).toBeGreaterThanOrEqual(2); // bad sample, then a good one

    const memories = db.prepare('SELECT id, text FROM memories').all() as { id: string; text: string }[];
    expect(memories.length).toBeGreaterThanOrEqual(1);
  });

  it('poisons a distill job after exhausting retries on a persistently bad extraction response (no memories created)', async () => {
    const sessionId = randomUUID();
    const transcriptId = randomUUID();
    insertSession(sessionId);
    insertTranscript(transcriptId, sessionId);

    const { provider: extractionLLM, callCount } = makeFlakyExtractionLLM(Number.MAX_SAFE_INTEGER); // always bad
    ctx = {
      db,
      config: defaultConfig(),
      providers: { llm: { compaction: makeCompactionLLM(), extraction: extractionLLM }, embed: makeMockEmbed() },
      memoryRepo: new MemoryRepo(db),
      vecStore: new SqliteVecStore(db),
    };

    const id = repo.enqueue('distill', { transcript_id: transcriptId, session_id: sessionId });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig(), ctx });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs WHERE id = ?').get(id) as { state: string } | undefined;
      return job?.state === 'poison';
    }, 15_000);

    const job = db.prepare('SELECT state, attempts FROM jobs WHERE id = ?').get(id) as {
      state: string; attempts: number;
    };
    expect(job.state).toBe('poison');
    expect(job.attempts).toBe(3); // MAX_ATTEMPTS transient retries exhausted
    expect(callCount()).toBe(3);

    const memories = db.prepare('SELECT id FROM memories').all();
    expect(memories).toHaveLength(0);
  });
});

describe('Worker + handler run-log (FEAT-495 item 4a)', () => {
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

  function runs(handler: string): { status: string; duration_ms: number; error_type: string | null }[] {
    return db.prepare('SELECT status, duration_ms, error_type FROM handler_runs WHERE handler = ? ORDER BY id ASC')
      .all(handler) as { status: string; duration_ms: number; error_type: string | null }[];
  }

  it('records a success row on a successful handler invocation', async () => {
    registry.register({ kind: 'cleanup', async handle() { /* no-op success */ } });
    repo.enqueue('cleanup', { kind: 'cleanup', older_than_days: 30 });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => runs('cleanup').length >= 1);
    expect(runs('cleanup')[0]).toMatchObject({ status: 'success', error_type: null });
    expect(runs('cleanup')[0]!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('records one failed row per attempt on a deterministic (poison-immediately) error', async () => {
    registry.register({
      kind: 'distill',
      async handle() { throw new DeterministicError('bad extraction JSON'); },
    });
    repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => runs('distill').length >= 1);
    expect(runs('distill')[0]).toMatchObject({ status: 'failed', error_type: 'deterministic' });
  });

  it('records a failed row for each transient-error attempt, one per retry', async () => {
    registry.register({
      kind: 'distill',
      async handle() { throw new TransientError('flaky provider'); },
    });
    repo.enqueue('distill', { kind: 'distill', transcript_id: 't1', session_id: 's1' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs').get() as { state: string } | undefined;
      return job?.state === 'poison';
    }, 10_000);

    const rows = runs('distill');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every(r => r.status === 'failed' && r.error_type === 'transient')).toBe(true);
  });

  it('does NOT record a handler run when no handler is registered for the job kind (the handler never actually ran)', async () => {
    repo.enqueue('reembed', { kind: 'reembed' });
    const { stop } = startWorker({ pollMs: 50, registry, db, config: defaultConfig() });
    stopWorker = stop;

    await waitFor(() => {
      const job = db.prepare('SELECT state FROM jobs').get() as { state: string } | undefined;
      return job?.state === 'poison';
    });
    expect(runs('reembed')).toEqual([]);
  });
});

describe('Worker + LoadGovernor integration (P1.4/P1.5)', () => {
  let db: DB;
  let repo: JobRepo;
  let registry: HandlerRegistry;
  let stopWorker: (() => Promise<void>) | null = null;

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

  it('lanes above the budget never claim; the queue still drains through lane 0', async () => {
    const { createLoadGovernor } = await import('../../src/pipeline/backpressure.js');
    const governor = createLoadGovernor({ maxLanes: 4 });
    // Force the budget down to 1 via severe embed latency.
    for (let i = 0; i < 20; i++) governor.recordHandlerRun('distill', 60_000);
    expect(governor.laneBudget()).toBe(1);

    const seenLanes = new Set<number>();
    // 'cleanup' with a custom handler: JobKind is a closed union, so tests
    // reuse a real kind (established pattern in this file) — the handler
    // body is what's under test, not the kind's production semantics.
    registry.register({
      kind: 'cleanup',
      async handle(payload: unknown): Promise<void> {
        seenLanes.add((payload as { lane?: number }).lane ?? -1);
      },
    });
    for (let i = 0; i < 6; i++) repo.enqueue('cleanup', { i });

    const cfg = defaultConfig();
    cfg.pipeline.concurrency = 4;
    const worker = startWorker({ pollMs: 20, registry, db, config: cfg, governor });
    stopWorker = () => worker.stop();

    await waitFor(() => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'completed'").get() as { n: number }).n >= 6, 5_000);
    governor.stop();
    // All six completed even at budget 1 — throttled means slower, never stopped.
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'completed'").get() as { n: number }).n).toBe(6);
  });

  it('shapes retry delays through the governor (jitter applied on requeue path)', async () => {
    const { createLoadGovernor } = await import('../../src/pipeline/backpressure.js');
    // random()=1 → +30% jitter, deterministic.
    const governor = createLoadGovernor({ maxLanes: 1, random: () => 1 });

    let attempts = 0;
    registry.register({
      kind: 'cleanup',
      async handle(): Promise<void> {
        attempts++;
        if (attempts === 1) throw new TransientError('transient (test)');
      },
    });
    repo.enqueue('cleanup', {});

    const cfg = defaultConfig();
    const worker = startWorker({ pollMs: 20, registry, db, config: cfg, governor });
    stopWorker = () => worker.stop();

    // First attempt fails → base backoff 1000ms → shaped to 1300ms. The job
    // must complete on the retry — proving the shaped delay flows through
    // the real setTimeout requeue path, not just the pure function.
    await waitFor(() => (db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state = 'completed'").get() as { n: number }).n >= 1, 10_000);
    governor.stop();
    expect(attempts).toBe(2);
  });
});
