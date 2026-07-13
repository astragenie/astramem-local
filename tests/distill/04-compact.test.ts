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
