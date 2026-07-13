import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { extractChunk, extract, BudgetExceeded } from '../../src/distill/stages/05-extract.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  EXTRACTION_SYSTEM_PROMPT_V3,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
} from '../../src/distill/prompts/extract.js';
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

  it('coerces an out-of-enum entity kind to "other" instead of dropping the whole atom', async () => {
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
    // An unrecognized entities[] kind must not sink the whole atom (silent
    // data loss) — it is safe-narrowed to 'other', matching the cloud-side
    // EntityKinds.Normalize() pattern (AstraMemory.Domain/EntityKinds.cs).
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0].text).toBe('some fact about a thing');
    expect(result.atoms[0].entities).toEqual([{ name: 'Whatever', kind: 'other' }]);
  });

  it('coerces only the bad entity, leaving valid entities on the same atom untouched', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const mixedKinds = JSON.stringify({
      atoms: [
        {
          type: 'fact',
          text: 'Postgres was chosen by Alice for the analytics store',
          importance: 0.6,
          confidence: 0.7,
          entities: [
            { name: 'Postgres', kind: 'tech' },
            { name: 'Alice', kind: 'human' }, // stale/unrecognized kind string
          ],
        },
      ],
    });
    const llm = makeMockLLM([mixedKinds]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0].entities).toEqual([
      { name: 'Postgres', kind: 'tech' },
      { name: 'Alice', kind: 'other' },
    ]);
  });

  it('still drops an atom that fails validation for a reason other than entity kind', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const badType = JSON.stringify({
      atoms: [
        {
          type: 'not-a-real-atom-type',
          text: 'some fact about a thing',
          importance: 0.5,
          confidence: 0.5,
        },
      ],
    });
    const llm = makeMockLLM([badType]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
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

  // FEAT-481 (SLICE-2/SLICE-435) AC-6/AC-7 — relations[] schema + guard.
  describe('relations[] (FEAT-481)', () => {
    it('parses a valid relation whose subject/object are both in this atom\'s entities[]', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const withRelation = JSON.stringify({
        atoms: [
          {
            type: 'decision',
            text: 'astramemory-local uses SQLite for storage',
            importance: 0.8,
            confidence: 0.9,
            entities: [
              { name: 'astramemory-local', kind: 'project' },
              { name: 'SQLite', kind: 'tech' },
            ],
            relations: [
              { subject: 'astramemory-local', predicate: 'uses', object: 'SQLite', confidence: 0.9 },
            ],
          },
        ],
      });
      const llm = makeMockLLM([withRelation]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].relations).toEqual([
        { subject: 'astramemory-local', predicate: 'uses', object: 'SQLite', confidence: 0.9 },
      ]);
    });

    it('an atom with no relations field parses fine — absent is byte-identical to today (additive compatibility)', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const llm = makeMockLLM([VALID_EXTRACTION_JSON]); // no relations field anywhere
      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(2);
      expect(result.atoms[0].relations).toBeUndefined();
      expect(result.atoms[1].relations).toBeUndefined();
    });

    it('drops a relation with an unknown predicate — NOT coerced to "other", NOT atom-fatal', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const badPredicate = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'Alice manages the deploy pipeline for the team',
            importance: 0.6,
            confidence: 0.7,
            entities: [
              { name: 'Alice', kind: 'actor' },
              { name: 'the deploy pipeline', kind: 'concept' },
            ],
            relations: [
              // 'manages' is not one of the 11 closed predicates
              { subject: 'Alice', predicate: 'manages', object: 'the deploy pipeline' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([badPredicate]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      // The atom itself survives; only the bad relation is dropped.
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].text).toBe('Alice manages the deploy pipeline for the team');
      expect(result.atoms[0].relations).toEqual([]);
    });

    it('drops a relation whose subject is not in this atom\'s own entities[] (no-hallucination guard, AC-7)', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const hallucinated = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'Alice owns the deploy script',
            importance: 0.6,
            confidence: 0.7,
            entities: [{ name: 'Alice', kind: 'actor' }],
            relations: [
              // "the deploy script" was never listed in entities[] above
              { subject: 'Alice', predicate: 'owned_by', object: 'the deploy script' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([hallucinated]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].relations).toEqual([]);
    });

    it('drops a relation whose object is not in this atom\'s own entities[]', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const hallucinated = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'the deploy script is owned by Alice',
            importance: 0.6,
            confidence: 0.7,
            entities: [{ name: 'the deploy script', kind: 'concept' }],
            relations: [
              { subject: 'the deploy script', predicate: 'owned_by', object: 'Alice' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([hallucinated]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].relations).toEqual([]);
    });

    it('name-matching is case/whitespace-normalized (normalizeEntityName), same seam as entity linking', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const caseVariant = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'Astramemory-local uses SQLite',
            importance: 0.6,
            confidence: 0.7,
            entities: [
              { name: 'astramemory-local', kind: 'project' },
              { name: '  SQLite  ', kind: 'tech' },
            ],
            relations: [
              // different case/whitespace than the entities[] entries above
              { subject: 'Astramemory-Local', predicate: 'uses', object: 'sqlite' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([caseVariant]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].relations).toEqual([
        { subject: 'Astramemory-Local', predicate: 'uses', object: 'sqlite' },
      ]);
    });

    it('drops a relation where subject === object', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const selfRelation = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'Alice is Alice',
            importance: 0.3,
            confidence: 0.5,
            entities: [{ name: 'Alice', kind: 'actor' }],
            relations: [
              { subject: 'Alice', predicate: 'relates_to', object: 'Alice' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([selfRelation]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].relations).toEqual([]);
    });

    it('keeps valid relations while dropping only the invalid ones on the same atom', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const mixed = JSON.stringify({
        atoms: [
          {
            type: 'decision',
            text: 'astramemory-local uses SQLite instead of Postgres',
            importance: 0.8,
            confidence: 0.9,
            entities: [
              { name: 'astramemory-local', kind: 'project' },
              { name: 'SQLite', kind: 'tech' },
              { name: 'Postgres', kind: 'tech' },
            ],
            relations: [
              { subject: 'astramemory-local', predicate: 'uses', object: 'SQLite', confidence: 0.9 },
              { subject: 'astramemory-local', predicate: 'replaces', object: 'Postgres' },
              // hallucinated endpoint — not in entities[]
              { subject: 'astramemory-local', predicate: 'uses', object: 'MongoDB' },
              // unknown predicate
              { subject: 'SQLite', predicate: 'beats', object: 'Postgres' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([mixed]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].relations).toEqual([
        { subject: 'astramemory-local', predicate: 'uses', object: 'SQLite', confidence: 0.9 },
        { subject: 'astramemory-local', predicate: 'replaces', object: 'Postgres' },
      ]);
    });

    // FEAT-481 SLICE-430 AC-12: relationDropCounts is the persisted signal
    // the doctor "Entity relations extraction" canary uses to distinguish
    // "the model never emits a relation" from "the model emits relations but
    // the guard drops every one" — both look identical from entity_relations
    // alone. Verifies the two dropped triples above (a hallucinated endpoint
    // and an unknown predicate) each land under their own reason key.
    it('relationDropCounts tallies one entry per drop reason (no_hallucination_guard, predicate_invalid)', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const mixed = JSON.stringify({
        atoms: [
          {
            type: 'decision',
            text: 'astramemory-local uses SQLite instead of Postgres',
            importance: 0.8,
            confidence: 0.9,
            entities: [
              { name: 'astramemory-local', kind: 'project' },
              { name: 'SQLite', kind: 'tech' },
              { name: 'Postgres', kind: 'tech' },
            ],
            relations: [
              { subject: 'astramemory-local', predicate: 'uses', object: 'SQLite', confidence: 0.9 },
              // hallucinated endpoint — not in entities[]
              { subject: 'astramemory-local', predicate: 'uses', object: 'MongoDB' },
              // unknown predicate
              { subject: 'SQLite', predicate: 'beats', object: 'Postgres' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([mixed]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.relationDropCounts).toEqual({
        no_hallucination_guard: 1,
        predicate_invalid: 1,
      });
    });

    it('relationDropCounts is {} when every relation in the chunk survives filtering', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const clean = JSON.stringify({
        atoms: [
          {
            type: 'decision', text: 'astramemory-local uses SQLite', importance: 0.8, confidence: 0.9,
            entities: [{ name: 'astramemory-local', kind: 'project' }, { name: 'SQLite', kind: 'tech' }],
            relations: [{ subject: 'astramemory-local', predicate: 'uses', object: 'SQLite' }],
          },
        ],
      });
      const llm = makeMockLLM([clean]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.relationDropCounts).toEqual({});
    });

    it('accepts the local-only "other" predicate', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const otherPredicate = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'Alice and Bob are somehow connected',
            importance: 0.5,
            confidence: 0.5,
            entities: [{ name: 'Alice', kind: 'actor' }, { name: 'Bob', kind: 'actor' }],
            relations: [{ subject: 'Alice', predicate: 'other', object: 'Bob' }],
          },
        ],
      });
      const llm = makeMockLLM([otherPredicate]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0].relations).toEqual([
        { subject: 'Alice', predicate: 'other', object: 'Bob' },
      ]);
    });
  });
});

// FEAT-479 (D3 §3.2) AC-2/AC-3/AC-4: per-run prompt resolution. The old
// module-load-time ACTIVE_EXTRACTION_PROMPT constant is gone — extractChunk/
// extract now resolve the system prompt on every call via
// resolveExtractionPrompt (src/distill/prompts/extract.ts), threading the
// `extractProfile` param through. These tests capture the actual system
// message sent to the provider to prove the resolved prompt (not just a
// default) really reaches the LLM call.
describe('extract stage — FEAT-479 profile threading', () => {
  function makeCapturingLLM(response: string): { llm: LLMProvider; systemPrompts: string[] } {
    const systemPrompts: string[] = [];
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
        systemPrompts.push(msgs.find(m => m.role === 'system')?.content ?? '');
        return { text: response, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    return { llm, systemPrompts };
  }

  it('SLICE-433 default: extractChunk called with no profile arg sends the v3 engineering-rich prompt (v1 no longer the default)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, systemPrompts } = makeCapturingLLM(VALID_EXTRACTION_JSON);

    await extractChunk(0, 'chunk text', llm, budget, 10.0);

    expect(systemPrompts).toHaveLength(1);
    expect(systemPrompts[0]).toBe(EXTRACTION_SYSTEM_PROMPT_V3);
    expect(systemPrompts[0]).not.toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it("SLICE-433 rollback lever: ASTRA_EXTRACT_PROMPT=v1 sends the original engineering prompt verbatim", async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, systemPrompts } = makeCapturingLLM(VALID_EXTRACTION_JSON);

    const prev = process.env.ASTRA_EXTRACT_PROMPT;
    process.env.ASTRA_EXTRACT_PROMPT = 'v1';
    try {
      await extractChunk(0, 'chunk text', llm, budget, 10.0);
    } finally {
      if (prev === undefined) delete process.env.ASTRA_EXTRACT_PROMPT;
      else process.env.ASTRA_EXTRACT_PROMPT = prev;
    }

    expect(systemPrompts[0]).toBe(EXTRACTION_SYSTEM_PROMPT);
  });

  it("extractChunk threads an explicit 'conversational' profile through to the sent system prompt", async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, systemPrompts } = makeCapturingLLM(VALID_EXTRACTION_JSON);

    await extractChunk(0, 'chunk text', llm, budget, 10.0, 'conversational');

    expect(systemPrompts[0]).toBe(EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL);
  });

  it('AC-4: ASTRA_EXTRACT_PROMPT=v2 env override wins over an explicit profile, per call (not cached at module load)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, systemPrompts } = makeCapturingLLM(VALID_EXTRACTION_JSON);

    const prev = process.env.ASTRA_EXTRACT_PROMPT;
    process.env.ASTRA_EXTRACT_PROMPT = 'v2';
    try {
      await extractChunk(0, 'chunk text', llm, budget, 10.0, 'conversational');
    } finally {
      if (prev === undefined) delete process.env.ASTRA_EXTRACT_PROMPT;
      else process.env.ASTRA_EXTRACT_PROMPT = prev;
    }

    expect(systemPrompts[0]).toBe(EXTRACTION_SYSTEM_PROMPT_V2);
  });

  it("extract() threads the profile through to every chunk's extractChunk call", async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, systemPrompts } = makeCapturingLLM(VALID_EXTRACTION_JSON);

    await extract(
      [{ index: 0, text: 'chunk one' }, { index: 1, text: 'chunk two' }],
      llm,
      budget,
      10.0,
      'conversational',
    );

    expect(systemPrompts).toEqual([
      EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
      EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
    ]);
  });
});
