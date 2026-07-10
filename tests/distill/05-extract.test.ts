import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { extractChunk, extract, BudgetExceeded } from '../../src/distill/stages/05-extract.js';
import { BudgetTracker } from '../../src/budget/tracker.js';
import { TransientError } from '../../src/pipeline/errors.js';
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

  it('throws TransientError on invalid JSON (no inline retry — worker owns retry policy)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    // Only one response queued — the stage itself must NOT issue a second
    // LLM call; retrying a parse failure is the worker's job (it classifies
    // TransientError and retries up to its attempt cap before poisoning).
    let callCount = 0;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(_msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
        callCount++;
        return { text: INVALID_JSON, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };

    await expect(
      extractChunk(0, 'chunk text', llm, budget, 10.0),
    ).rejects.toBeInstanceOf(TransientError);

    // Exactly one LLM call per invocation — no inline retry budget waste
    expect(callCount).toBe(1);
  });

  it('a retried call (as the worker performs on TransientError) succeeds once the LLM returns valid JSON', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    // extractChunk itself does not retry inline (see prior test) — this
    // reproduces what the worker does across two separate job attempts:
    // call extractChunk again after a TransientError, same chunk, LLM
    // recovers on the next sample (stochastic JSON output).
    const llm = makeMockLLM([INVALID_JSON, SECOND_ATTEMPT_VALID]);

    await expect(extractChunk(0, 'chunk text', llm, budget, 10.0)).rejects.toBeInstanceOf(TransientError);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0].type).toBe('lesson');
    expect(result.atoms[0].text).toContain('better-sqlite3');
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

  // FEAT-402 AC-1 — entities are emitted in the SAME extraction call as the
  // atom, no separate LLM round trip.
  it('parses entities emitted alongside an atom in the same response', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const withEntities = JSON.stringify({
      atoms: [
        {
          type: 'decision',
          text: 'use Postgres for the analytics store',
          importance: 0.8,
          confidence: 0.9,
          entities: [{ name: 'Postgres', kind: 'tech' }],
        },
      ],
    });
    const llm = makeMockLLM([withEntities]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0].entities).toEqual([{ name: 'Postgres', kind: 'tech' }]);
  });

  it('atom with no named entity omits/empties entities without failing validation', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON]); // no entities field on either atom
    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(2);
    expect(result.atoms[0].entities).toBeUndefined();
  });

  it('drops an atom whose entities entry has an invalid kind, keeps the atom without it', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const badKind = JSON.stringify({
      atoms: [
        {
          type: 'fact',
          text: 'some fact about a thing',
          importance: 0.5,
          confidence: 0.5,
          entities: [{ name: 'Whatever', kind: 'not-a-real-kind' }],
        },
      ],
    });
    const llm = makeMockLLM([badKind]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    // AtomSchema validates the whole atom — an invalid nested entities[] kind
    // fails the atom, matching the existing "drop malformed atoms silently" behavior.
    expect(result.atoms).toEqual([]);
  });

  // FEAT-453 AC-4 — a stated valid_at/invalid_at hint on an entities[] item
  // round-trips through AtomEntitySchema validation unchanged.
  it('parses valid_at/invalid_at hints emitted alongside an entity', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const withValidity = JSON.stringify({
      atoms: [
        {
          type: 'fact',
          text: 'Alice was the approver from January to March',
          importance: 0.6,
          confidence: 0.8,
          entities: [{
            name: 'Alice', kind: 'actor', subtype: 'human',
            valid_at: '2026-01-01T00:00:00.000Z',
            invalid_at: '2026-03-01T00:00:00.000Z',
          }],
        },
      ],
    });
    const llm = makeMockLLM([withValidity]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0].entities).toEqual([{
      name: 'Alice', kind: 'actor', subtype: 'human',
      valid_at: '2026-01-01T00:00:00.000Z',
      invalid_at: '2026-03-01T00:00:00.000Z',
    }]);
  });

  // FEAT-453 AC-5 — omitting valid_at/invalid_at (the "no stated hint" case)
  // still validates and leaves both fields absent, not defaulted.
  it('an entity with no stated validity hint parses with valid_at/invalid_at both absent', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const noHint = JSON.stringify({
      atoms: [
        {
          type: 'fact',
          text: 'Bob is mentioned with no stated date',
          importance: 0.4,
          confidence: 0.6,
          entities: [{ name: 'Bob', kind: 'actor', subtype: 'human' }],
        },
      ],
    });
    const llm = makeMockLLM([noHint]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0].entities?.[0].valid_at).toBeUndefined();
    expect(result.atoms[0].entities?.[0].invalid_at).toBeUndefined();
  });
});
