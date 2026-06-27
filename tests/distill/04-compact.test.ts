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
