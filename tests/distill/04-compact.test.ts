import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { compact, compactChunk, BudgetExceeded } from '../../src/distill/stages/04-compact.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../src/contracts/index.js';

function makeMockLLM(responseText: string, usdCost = 0): LLMProvider {
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_messages: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      return { text: responseText, usage: { in: 100, out: 50, usd: usdCost } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 10 };
    },
  };
}

describe('compact stage', () => {
  it('compacts a chunk via LLM and returns result', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM('compressed text');

    const result = await compactChunk(
      { index: 0, text: 'Some verbose transcript content' },
      llm,
      budget,
      10.0,
    );

    expect(result.index).toBe(0);
    expect(result.text).toBe('compressed text');
    expect(result.usageUsd).toBe(0);
  });

  it('returns empty text for empty chunk without calling LLM', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM('should not be called');
    const chatSpy = vi.spyOn(llm, 'chat');

    const result = await compactChunk({ index: 0, text: '' }, llm, budget, 10.0);
    expect(result.text).toBe('');
    expect(chatSpy).not.toHaveBeenCalled();
  });

  it('throws BudgetExceeded when cap is hit', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    // Record spend near cap
    budget.record(9.9999);

    const llm = makeMockLLM('result');

    await expect(
      compactChunk({ index: 0, text: 'some content to compact' }, llm, budget, 10.0),
    ).rejects.toThrow(BudgetExceeded);
  });

  it('compact() processes all chunks in sequence', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    let callCount = 0;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> {
        callCount++;
        return { text: `compacted-${callCount}`, usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };

    const results = await compact(
      [
        { index: 0, text: 'chunk one' },
        { index: 1, text: 'chunk two' },
        { index: 2, text: 'chunk three' },
      ],
      llm,
      budget,
      10.0,
    );

    expect(results.length).toBe(3);
    expect(callCount).toBe(3);
    expect(results[0].text).toBe('compacted-1');
    expect(results[1].text).toBe('compacted-2');
  });

  it('records actual USD cost in budget after each call', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM('result', 0.0005);

    await compactChunk({ index: 0, text: 'content' }, llm, budget, 10.0);
    const t = budget.today();
    expect(t.usd_total).toBeCloseTo(0.0005);
    expect(t.calls).toBe(1);
  });
});

// FEAT-482: bounded-concurrency chunk fan-out. compact() now delegates to
// mapWithConcurrency (src/distill/concurrency.ts) — these tests pin the
// compact()-level integration of that helper's invariants.
describe('compact() concurrency (FEAT-482)', () => {
  it('concurrency=1 (the default, omitted) reproduces the pre-FEAT-482 sequential loop byte-for-byte', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const callOrder: number[] = [];
    let callCount = 0;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> {
        callCount++;
        callOrder.push(callCount);
        return { text: `compacted-${callCount}`, usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };

    const results = await compact(
      [
        { index: 0, text: 'chunk one' },
        { index: 1, text: 'chunk two' },
        { index: 2, text: 'chunk three' },
      ],
      llm,
      budget,
      10.0,
      // concurrency omitted — must default to 1
    );

    expect(callOrder).toEqual([1, 2, 3]);
    expect(results.map(r => r.text)).toEqual(['compacted-1', 'compacted-2', 'compacted-3']);
  });

  it('concurrency > 1 processes chunks out of dispatch order but preserves result order by chunk index', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    // Chunk 0's LLM call resolves slower than chunk 1's — proves the result
    // array stays index-ordered even when chunk 1 finishes first.
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        const userText = msgs.find(m => m.role === 'user')?.content ?? '';
        const delayMs = userText.includes('slow') ? 15 : 0;
        await new Promise(r => setTimeout(r, delayMs));
        return { text: `done:${userText}`, usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };

    const results = await compact(
      [
        { index: 0, text: 'slow chunk' },
        { index: 1, text: 'fast chunk' },
      ],
      llm,
      budget,
      10.0,
      2,
    );

    expect(results[0]?.text).toBe('done:slow chunk');
    expect(results[1]?.text).toBe('done:fast chunk');
  });

  it('budget-stop: once one chunk hits BudgetExceeded, compact() rejects with it and stops dispatching further chunks', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    // Cap so tight that even a single chunk's estimate exceeds it — every
    // dispatched compactChunk call throws BudgetExceeded synchronously
    // (before any provider.chat call), so this exercises the "no further
    // NEW dispatch" half of the invariant without needing timing control.
    const capUsd = 0;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> {
        // Should never be reached — assertCanSpend throws first.
        throw new Error('provider.chat should not be called when cap is 0');
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };
    const chunks = [0, 1, 2, 3, 4].map(i => ({ index: i, text: `chunk ${i}` }));

    // With concurrency=2, at most the two workers' first grab (indices 0
    // and 1) can be dispatched before the stop flag halts further claims —
    // chunks 2-4 must never be attempted (mapWithConcurrency's own
    // unit tests in tests/distill/concurrency.test.ts pin the exact
    // dispatch-count behavior; this integration test pins that compact()
    // itself rejects with the right error type end to end).
    await expect(compact(chunks, llm, budget, capUsd, 2)).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it('setting concurrency explicitly to 1 is the documented safety valve — identical results/order to the default', async () => {
    const dbA = openDb(':memory:');
    migrate(dbA);
    const dbB = openDb(':memory:');
    migrate(dbB);
    const budgetA = new BudgetTracker(dbA);
    const budgetB = new BudgetTracker(dbB);
    const makeLLM = () => makeMockLLM('same-result');
    const chunks = [
      { index: 0, text: 'a' },
      { index: 1, text: 'b' },
    ];

    const withDefault = await compact(chunks, makeLLM(), budgetA, 10.0);
    const withExplicitOne = await compact(chunks, makeLLM(), budgetB, 10.0, 1);

    expect(withExplicitOne).toEqual(withDefault);
  });
});

// chunk-retry-amplification fix: worker.ts retries a FAILED job at the JOB
// level by re-invoking runPipeline() (and therefore compact()) from scratch.
// Without checkpointing, one transient failure on a late chunk replayed
// every earlier chunk's LLM call too, multiplying a single rate-limit event
// into up to MAX_ATTEMPTS (3) x the calls. Passing the same `jobKey` across
// two separate compact() invocations (simulating the worker's own retry —
// same job, same content, two calls) must skip re-dispatching chunks that
// already succeeded on the first call.
describe('compact() retry checkpointing (chunk-retry-amplification fix)', () => {
  it('a retried compact() call with the same jobKey does not re-issue LLM calls for chunks that already succeeded', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const jobKey = 'session-hash-abc123';
    const chunks = Array.from({ length: 20 }, (_, i) => ({ index: i, text: `chunk ${i} content` }));

    let callCount = 0;
    let rateLimitFired = false;
    const RATE_LIMIT_AT_INDEX = 14; // "chunk 15" (1-indexed) of a 20-chunk session
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        callCount++;
        const userText = msgs.find(m => m.role === 'user')?.content ?? '';
        const idx = Number(userText.match(/chunk (\d+) content/)?.[1]);
        // Fires exactly once — a real rate limit clears by the time the
        // worker retries; the mock must not throw forever or it can't
        // distinguish "checkpoint skipped this chunk" from "checkpoint
        // still retries every chunk, including the bad one, and happens to
        // fail the same way".
        if (idx === RATE_LIMIT_AT_INDEX && !rateLimitFired) {
          rateLimitFired = true;
          throw new Error('rate limited (429)');
        }
        return { text: `compacted-${idx}`, usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };

    // Attempt 1: fails at chunk 14 — chunks 0-13 succeeded first.
    await expect(compact(chunks, llm, budget, 10.0, 1, jobKey)).rejects.toThrow('rate limited');
    expect(callCount).toBe(RATE_LIMIT_AT_INDEX + 1); // chunks 0..14 attempted, 14 succeeded, 15th (idx 14) threw

    const callsAfterFirstAttempt = callCount;

    // Attempt 2 (the worker's retry, same job/content — same jobKey): the
    // rate limit has cleared. This must NOT re-issue LLM calls for chunks
    // 0-13, which already succeeded on attempt 1.
    const results = await compact(chunks, llm, budget, 10.0, 1, jobKey);

    const callsOnRetry = callCount - callsAfterFirstAttempt;
    // Only chunks 14..19 (6 chunks) needed a fresh LLM call on the retry —
    // NOT all 20. Total calls across both attempts: 15 (attempt 1) + 6
    // (attempt 2) = 21, not 15 + 20 = 35, and nowhere near the naive
    // MAX_ATTEMPTS=3 full-replay worst case of 3 x 20 = 60.
    expect(callsOnRetry).toBe(chunks.length - RATE_LIMIT_AT_INDEX);
    expect(results.length).toBe(20);
    expect(results.map(r => r.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(results[0]?.text).toBe('compacted-0');
    expect(results[19]?.text).toBe('compacted-19');
  });

  it('a fresh jobKey (different job) does not reuse another job\'s checkpoints', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    let callCount = 0;
    const llm = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> {
        callCount++;
        return { text: `compacted-${callCount}`, usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    } satisfies LLMProvider;
    const chunks = [{ index: 0, text: 'a' }, { index: 1, text: 'b' }];

    await compact(chunks, llm, budget, 10.0, 1, 'job-A');
    expect(callCount).toBe(2);

    await compact(chunks, llm, budget, 10.0, 1, 'job-B');
    expect(callCount).toBe(4); // a different job re-runs every chunk — no cross-job leakage
  });

  it('omitting jobKey preserves the old behavior — every call re-dispatches every chunk', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    let callCount = 0;
    const llm = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> {
        callCount++;
        return { text: `compacted-${callCount}`, usage: { in: 10, out: 5, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    } satisfies LLMProvider;
    const chunks = [{ index: 0, text: 'a' }, { index: 1, text: 'b' }];

    await compact(chunks, llm, budget, 10.0); // no jobKey
    expect(callCount).toBe(2);
    await compact(chunks, llm, budget, 10.0); // no jobKey — no caching, full re-dispatch
    expect(callCount).toBe(4);
  });
});
