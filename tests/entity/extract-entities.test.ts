import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { extractEntitiesForText } from '../../src/entity/extract-entities.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../src/contracts/index.js';

function makeMockLLM(response: string, usdCost = 0): LLMProvider {
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      return { text: response, usage: { in: 50, out: 20, usd: usdCost } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

describe('extractEntitiesForText', () => {
  it('returns [] for empty text without calling the LLM', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    let called = false;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> { called = true; return { text: '{}', usage: { in: 0, out: 0, usd: 0 } }; },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };

    const result = await extractEntitiesForText('', llm, budget, 10.0);
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('parses a valid entities response', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM(JSON.stringify({ entities: [{ name: 'Postgres', kind: 'tech' }] }));

    const result = await extractEntitiesForText('use Postgres for storage', llm, budget, 10.0);
    expect(result).toEqual([{ name: 'Postgres', kind: 'tech' }]);
  });

  it('returns [] for malformed JSON (never throws)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM('not json at all');

    const result = await extractEntitiesForText('some text', llm, budget, 10.0);
    expect(result).toEqual([]);
  });

  it('handles markdown-fenced JSON', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const fenced = '```json\n' + JSON.stringify({ entities: [{ name: 'TypeScript', kind: 'tech' }] }) + '\n```';
    const llm = makeMockLLM(fenced);

    const result = await extractEntitiesForText('some text', llm, budget, 10.0);
    expect(result).toEqual([{ name: 'TypeScript', kind: 'tech' }]);
  });

  it('drops entities with an invalid kind, keeps valid ones', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM(JSON.stringify({
      entities: [
        { name: 'Postgres', kind: 'tech' },
        { name: 'bogus', kind: 'not-a-kind' },
      ],
    }));

    const result = await extractEntitiesForText('mixed text', llm, budget, 10.0);
    expect(result).toEqual([{ name: 'Postgres', kind: 'tech' }]);
  });

  it('returns [] when budget is exhausted, without calling the LLM', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    budget.record(9.9999);
    let called = false;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> { called = true; return { text: '{"entities":[]}', usage: { in: 0, out: 0, usd: 0 } }; },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };

    const result = await extractEntitiesForText('some reasonably long piece of text here', llm, budget, 10.0);
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });
});
