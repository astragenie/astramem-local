import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { extractChunk, extract, BudgetExceeded } from '../../src/distill/stages/05-extract.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import type { LLMProvider, ChatMsg, ChatOpts, ChatResult, LLMHealth } from '../../src/contracts/index.js';

const VALID_EXTRACTION_JSON = JSON.stringify({
  atoms: [
    {
      type: 'decision',
      text: 'use sqlite-vec for vector storage in v1',
      importance: 0.9,
      confidence: 0.9,
      evidence: 'We decided to use sqlite-vec'
    },
    {
      type: 'fact',
      text: 'port 7777 is the default daemon port',
      importance: 0.6,
      confidence: 0.95
    }
  ]
});

const INVALID_JSON = 'This is not JSON at all, sorry!';

const SECOND_ATTEMPT_VALID = JSON.stringify({
  atoms: [
    {
      type: 'lesson',
      text: 'Bun does not support better-sqlite3 on Windows without special flags',
      importance: 0.8,
      confidence: 0.85
    }
  ]
});

function makeMockLLM(responses: string[], usdCost = 0): LLMProvider {
  let call = 0;
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      const text = responses[call] ?? responses[responses.length - 1];
      call++;
      return { text, usage: { in: 100, out: 50, usd: usdCost } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

describe('extract stage', () => {
  it('extracts atoms from valid JSON response', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON]);

    const result = await extractChunk(0, 'some chunk text', llm, budget, 10.0);

    expect(result.chunkIndex).toBe(0);
    expect(result.atoms.length).toBe(2);
    expect(result.atoms[0].type).toBe('decision');
    expect(result.atoms[0].text).toContain('sqlite-vec');
    expect(result.retried).toBe(false);
  });

  it('retries on invalid JSON and succeeds on second attempt', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([INVALID_JSON, SECOND_ATTEMPT_VALID]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);

    expect(result.retried).toBe(true);
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0].type).toBe('lesson');
  });

  it('returns empty atoms and retried=true when both attempts fail', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([INVALID_JSON, INVALID_JSON]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);

    expect(result.retried).toBe(true);
    expect(result.atoms).toEqual([]);
  });

  it('returns empty atoms without LLM call for empty chunk', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    let calls = 0;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test',
      async chat(): Promise<ChatResult> { calls++; return { text: '{}', usage: { in: 0, out: 0, usd: 0 } }; },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test', latency_ms: 0 }; },
    };

    const result = await extractChunk(0, '', llm, budget, 10.0);
    expect(result.atoms).toEqual([]);
    expect(calls).toBe(0);
  });

  it('throws BudgetExceeded when cap is hit', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    budget.record(9.9999);

    const llm = makeMockLLM([VALID_EXTRACTION_JSON]);

    await expect(
      extractChunk(0, 'some content', llm, budget, 10.0),
    ).rejects.toThrow(BudgetExceeded);
  });

  it('handles JSON wrapped in markdown fences', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const fenced = '```json\n' + VALID_EXTRACTION_JSON + '\n```';
    const llm = makeMockLLM([fenced]);

    const result = await extractChunk(0, 'chunk', llm, budget, 10.0);
    expect(result.atoms.length).toBe(2);
  });

  it('records budget spend after successful call', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON], 0.0003);

    await extractChunk(0, 'content', llm, budget, 10.0);
    const t = budget.today();
    expect(t.usd_total).toBeCloseTo(0.0003);
  });

  it('extract() processes multiple chunks', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON, VALID_EXTRACTION_JSON]);

    const results = await extract(
      [{ index: 0, text: 'chunk one' }, { index: 1, text: 'chunk two' }],
      llm,
      budget,
      10.0,
    );

    expect(results.length).toBe(2);
    expect(results[0].atoms.length).toBe(2);
    expect(results[1].atoms.length).toBe(2);
  });

  it('rejects atoms with text shorter than 5 chars', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const shortAtom = JSON.stringify({
      atoms: [{ type: 'fact', text: 'hi', importance: 0.5, confidence: 0.5 }]
    });
    const llm = makeMockLLM([shortAtom]);

    const result = await extractChunk(0, 'content', llm, budget, 10.0);
    expect(result.atoms).toEqual([]);
  });
});
