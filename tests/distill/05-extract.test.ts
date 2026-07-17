import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { extractChunk, extract, BudgetExceeded } from '../../src/distill/stages/05-extract.js';
import {
  EXTRACTION_SYSTEM_PROMPT,
  EXTRACTION_SYSTEM_PROMPT_V2,
  EXTRACTION_SYSTEM_PROMPT_V3,
  EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL,
  ExtractionSchema,
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
      confidence: 0.85,
      // FEAT-485: lesson/decision atoms are dropped without a non-empty
      // evidence excerpt (requireEvidenceForRichTypes) — this fixture tests
      // the retry path, not evidence policy, so it supplies one.
      evidence: 'Bun does not support better-sqlite3 on Windows without special flags'
    }
  ]
});

function makeMockLLM(responses: string[], usdCost = 0): LLMProvider {
  if (responses.length === 0) throw new Error('makeMockLLM requires at least one response');
  let call = 0;
  return {
    name: 'ollama' as const,
    model: 'test-model',
    async chat(_msgs: ChatMsg[], _opts?: ChatOpts): Promise<ChatResult> {
      const text = responses[call] ?? responses[responses.length - 1]!;
      call++;
      return { text, usage: { in: 100, out: 50, usd: usdCost } };
    },
    async health(): Promise<LLMHealth> {
      return { ok: true, model: 'test-model', latency_ms: 0 };
    },
  };
}

describe('extract stage', () => {
  // 2026-07-16 qwen3.5 duplicate-key collapse: bare format:"json" permits
  // `{"text":"A","text":"B"}` (valid JSON, last-key-wins parse -> ONE atom,
  // indistinguishable from under-extraction). The structured-output schema
  // is the fix — this pins that every extract call actually sends it,
  // derived from ExtractionSchema (the jsonSchema contract field was
  // built-wired-never-invoked before this).
  it('passes the ExtractionSchema-derived jsonSchema on every chat call', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const seen: (ChatOpts | undefined)[] = [];
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(_msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        seen.push(opts);
        return { text: VALID_EXTRACTION_JSON, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };

    await extractChunk(0, 'some chunk text', llm, budget, 10.0);

    expect(seen).toHaveLength(1);
    const schema = seen[0]?.jsonSchema as Record<string, unknown> | undefined;
    expect(schema).toBeDefined();
    // The call site must send exactly the ExtractionSchema-derived schema —
    // deep-equal against an independent conversion, so neither a drifted
    // hand-written copy nor a partial/stale schema can pass.
    expect(schema).toEqual(z.toJSONSchema(ExtractionSchema));
    // And the properties that actually defeat the collapse must be present
    // explicitly (a future converter change that silently dropped them
    // would still deep-equal above, so pin them by name too):
    const atoms = (schema!.properties as Record<string, Record<string, unknown>>).atoms!;
    expect(atoms.type).toBe('array');
    const items = atoms.items as Record<string, unknown>;
    expect(items.type).toBe('object');
    expect(items.required).toContain('text');
    expect(items.additionalProperties).toBe(false);
  });

  // FEAT-536 AC-4 (Wave 1): the capability registry (capabilities.ts) is
  // actually CONSULTED here, not dead code sitting next to it — a provider
  // whose capability is the bare 'json_object' bucket (azure-openai,
  // openai-compatible, codex-subscription, and every BYO preset resolving
  // through openai-compatible) never gets a jsonSchema on the wire, because
  // those providers ignore it anyway (contracts/llm.ts's `jsonSchema` doc
  // comment). This is the negative-space counterpart to the "on every chat
  // call" test above, which uses a `name: 'ollama'` mock — a
  // 'strict-schema' provider that DOES get the field.
  it('omits jsonSchema for a provider whose capability is bare json_object (azure-openai)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const seen: (ChatOpts | undefined)[] = [];
    const llm: LLMProvider = {
      name: 'azure-openai' as const,
      model: 'gpt-4.1',
      async chat(_msgs: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
        seen.push(opts);
        return { text: VALID_EXTRACTION_JSON, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'gpt-4.1', latency_ms: 0 };
      },
    };

    await extractChunk(0, 'some chunk text', llm, budget, 10.0);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.json).toBe(true);
    expect(seen[0]?.jsonSchema).toBeUndefined();
  });

  // Build-failing guard for the module-load conversion: a future
  // `.refine()`/`.transform()`/`.catch()` on AtomSchema (or anything it
  // nests) makes z.toJSONSchema throw AT IMPORT TIME of 05-extract.ts —
  // which is the daemon's distill boot path. This repo's history says a
  // comment alone does not survive contact with contributors
  // (guidance-cannot-fix-a-default); this test does.
  it('ExtractionSchema stays toJSONSchema-representable (module-load conversion must never throw)', () => {
    expect(() => z.toJSONSchema(ExtractionSchema)).not.toThrow();
  });

  it('extracts atoms from valid JSON response', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON]);

    const result = await extractChunk(0, 'some chunk text', llm, budget, 10.0);

    expect(result.chunkIndex).toBe(0);
    expect(result.atoms.length).toBe(2);
    expect(result.atoms[0]!.type).toBe('decision');
    expect(result.atoms[0]!.text).toContain('sqlite-vec');
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
    expect(result.atoms[0]!.type).toBe('lesson');
    expect(result.atoms[0]!.text).toContain('better-sqlite3');
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
    expect(results[0]!.atoms.length).toBe(2);
    expect(results[1]!.atoms.length).toBe(2);
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
          // FEAT-485: decision atoms require non-empty evidence — this
          // fixture tests entity parsing, not evidence policy.
          evidence: 'We decided to use Postgres for the analytics store',
          entities: [{ name: 'Postgres', kind: 'tech' }],
        },
      ],
    });
    const llm = makeMockLLM([withEntities]);

    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0]!.entities).toEqual([{ name: 'Postgres', kind: 'tech' }]);
  });

  it('atom with no named entity omits/empties entities without failing validation', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON]); // no entities field on either atom
    const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
    expect(result.atoms.length).toBe(2);
    expect(result.atoms[0]!.entities).toBeUndefined();
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
    expect(result.atoms[0]!.text).toBe('some fact about a thing');
    expect(result.atoms[0]!.entities).toEqual([{ name: 'Whatever', kind: 'other' }]);
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
    expect(result.atoms[0]!.entities).toEqual([
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
    expect(result.atoms[0]!.entities).toEqual([{
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
    expect(result.atoms[0]!.entities?.[0]!.valid_at).toBeUndefined();
    expect(result.atoms[0]!.entities?.[0]!.invalid_at).toBeUndefined();
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
            // FEAT-485: decision atoms require non-empty evidence — this
            // fixture tests relations[] parsing, not evidence policy.
            evidence: 'astramemory-local uses SQLite for storage',
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
      expect(result.atoms[0]!.relations).toEqual([
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
      expect(result.atoms[0]!.relations).toBeUndefined();
      expect(result.atoms[1]!.relations).toBeUndefined();
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
      expect(result.atoms[0]!.text).toBe('Alice manages the deploy pipeline for the team');
      expect(result.atoms[0]!.relations).toEqual([]);
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
      expect(result.atoms[0]!.relations).toEqual([]);
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
      expect(result.atoms[0]!.relations).toEqual([]);
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
      expect(result.atoms[0]!.relations).toEqual([
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
      expect(result.atoms[0]!.relations).toEqual([]);
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
            // FEAT-485: decision atoms require non-empty evidence — this
            // fixture tests relations[] filtering, not evidence policy.
            evidence: 'astramemory-local uses SQLite instead of Postgres',
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
      expect(result.atoms[0]!.relations).toEqual([
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
            // FEAT-485: decision atoms require non-empty evidence — this
            // fixture tests relationDropCounts tallying, not evidence policy.
            evidence: 'astramemory-local uses SQLite instead of Postgres',
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
            // FEAT-485: decision atoms require non-empty evidence — this
            // fixture tests relationDropCounts being empty, not evidence policy.
            evidence: 'astramemory-local uses SQLite',
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
      expect(result.atoms[0]!.relations).toEqual([
        { subject: 'Alice', predicate: 'other', object: 'Bob' },
      ]);
    });
  });

  // Issue #207 — entity extraction was emitting garbage names ("#110" as a
  // "repo" entity, live from production). filterAtomEntities is the
  // code-level backstop (the prompt is stochastic and cannot be relied on
  // alone) that drops bare issue/PR references, bare numbers, and names
  // below the length floor BEFORE they become permanent `entities` rows.
  describe('entities[] name-quality guard (issue #207)', () => {
    it('drops a bare issue/PR reference ("#110") but keeps a legitimate entity on the same atom', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const withJunk = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'Postgres was discussed in #110',
            importance: 0.5,
            confidence: 0.5,
            entities: [
              { name: '#110', kind: 'workitem' },
              { name: 'Postgres', kind: 'tech' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([withJunk]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([{ name: 'Postgres', kind: 'tech' }]);
    });

    it('drops a bare number ("123") entity name', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const withJunk = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'the value is 123',
            importance: 0.5,
            confidence: 0.5,
            entities: [{ name: '123', kind: 'other' }],
          },
        ],
      });
      const llm = makeMockLLM([withJunk]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([]);
    });

    it('drops a single-character entity name ("x") — below the length floor', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const withJunk = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'set x to true',
            importance: 0.5,
            confidence: 0.5,
            entities: [{ name: 'x', kind: 'other' }],
          },
        ],
      });
      const llm = makeMockLLM([withJunk]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([]);
    });

    it('keeps a legitimate 2-char entity name ("Go") — the length floor must not reject real short words', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const legit = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'the service is written in Go',
            importance: 0.5,
            confidence: 0.5,
            entities: [{ name: 'Go', kind: 'tech' }],
          },
        ],
      });
      const llm = makeMockLLM([legit]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([{ name: 'Go', kind: 'tech' }]);
    });

    // The length floor was `< 2 -> too_short`, which silently destroyed "C" and
    // "R" — real, commonly-referenced languages. The only test exercising the
    // floor used the placeholder "x", which MASKED the gap: "x" is junk, so the
    // test passed while the guard was eating real facts. A test written against
    // a placeholder cannot catch a bug about real values.
    it('keeps a SINGLE-CHARACTER tech name ("C") — a real language, not junk', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const legit = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'the parser was originally written in C',
            importance: 0.5,
            confidence: 0.5,
            entities: [{ name: 'C', kind: 'tech' }],
          },
        ],
      });
      const result = await extractChunk(0, 'chunk text', makeMockLLM([legit]), budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([{ name: 'C', kind: 'tech' }]);
    });

    it('keeps a SINGLE-CHARACTER tech name ("R") — the statistics language', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const legit = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'the analysis was done in R',
            importance: 0.5,
            confidence: 0.5,
            entities: [{ name: 'R', kind: 'tech' }],
          },
        ],
      });
      const result = await extractChunk(0, 'chunk text', makeMockLLM([legit]), budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([{ name: 'R', kind: 'tech' }]);
    });

    // The junk actually observed in production: single letters tagged `repo`.
    // A one-character REPO is not plausible; a one-character TECH is. Hence the
    // guard is kind-aware rather than a flat length floor.
    it('DROPS a single-character repo name ("a") — the actual junk seen in prod', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const junk = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'some fact',
            importance: 0.5,
            confidence: 0.5,
            entities: [{ name: 'a', kind: 'repo' }],
          },
        ],
      });
      const result = await extractChunk(0, 'chunk text', makeMockLLM([junk]), budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([]);
    });

    it('keeps legitimate multi-char entity names unaffected ("Postgres", "astramem-local")', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const legit = JSON.stringify({
        atoms: [
          {
            type: 'decision',
            text: 'astramem-local uses Postgres',
            importance: 0.7,
            confidence: 0.8,
            // FEAT-485: decision atoms require non-empty evidence — this
            // fixture tests entity-name-quality filtering, not evidence policy.
            evidence: 'astramem-local uses Postgres',
            entities: [
              { name: 'astramem-local', kind: 'project' },
              { name: 'Postgres', kind: 'tech' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([legit]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([
        { name: 'astramem-local', kind: 'project' },
        { name: 'Postgres', kind: 'tech' },
      ]);
    });

    it('a relation naming an already-dropped junk entity is caught by the existing no-hallucination guard (cascading drop)', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const cascading = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'Alice mentioned #110',
            importance: 0.5,
            confidence: 0.5,
            entities: [
              { name: 'Alice', kind: 'actor' },
              { name: '#110', kind: 'workitem' },
            ],
            relations: [
              { subject: 'Alice', predicate: 'mentions', object: '#110' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([cascading]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([{ name: 'Alice', kind: 'actor' }]);
      // The relation's object ("#110") no longer exists in entities[] once
      // filterAtomEntities drops it, so filterAtomRelations' pre-existing
      // no-hallucination guard drops the relation too — no separate check
      // needed for this cascade.
      expect(result.atoms[0]!.relations).toEqual([]);
    });

    it('entityDropCounts tallies one entry per drop reason', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const mixed = JSON.stringify({
        atoms: [
          {
            type: 'fact',
            text: 'various junk and one real entity',
            importance: 0.5,
            confidence: 0.5,
            entities: [
              { name: '#110', kind: 'workitem' },
              { name: '123', kind: 'other' },
              { name: 'x', kind: 'other' },
              { name: 'Postgres', kind: 'tech' },
            ],
          },
        ],
      });
      const llm = makeMockLLM([mixed]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.entityDropCounts).toEqual({
        bare_issue_ref: 1,
        bare_number: 1,
        too_short: 1,
      });
      expect(result.atoms.length).toBe(1);
      expect(result.atoms[0]!.entities).toEqual([{ name: 'Postgres', kind: 'tech' }]);
    });

    it('entityDropCounts is {} when every entity name in the chunk survives filtering', async () => {
      const db = openDb(':memory:');
      migrate(db);
      const budget = new BudgetTracker(db);
      const clean = JSON.stringify({
        atoms: [
          {
            type: 'fact', text: 'astramem-local uses Postgres', importance: 0.6, confidence: 0.7,
            entities: [{ name: 'astramem-local', kind: 'project' }, { name: 'Postgres', kind: 'tech' }],
          },
        ],
      });
      const llm = makeMockLLM([clean]);

      const result = await extractChunk(0, 'chunk text', llm, budget, 10.0);
      expect(result.entityDropCounts).toEqual({});
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

// FEAT-487: bounded-concurrency chunk fan-out. extract() now delegates to
// mapWithConcurrency (src/distill/concurrency.ts) — these tests pin the
// extract()-level integration of that helper's invariants.
describe('extract() concurrency (FEAT-487)', () => {
  it('concurrency=1 (the default, omitted) reproduces the pre-FEAT-487 sequential loop byte-for-byte', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const callOrder: number[] = [];
    const llm = makeMockLLM([VALID_EXTRACTION_JSON, VALID_EXTRACTION_JSON]);
    const chatSpy = vi.spyOn(llm, 'chat').mockImplementation(async (msgs) => {
      const userText = msgs.find(m => m.role === 'user')?.content ?? '';
      callOrder.push(userText.includes('one') ? 0 : 1);
      return { text: VALID_EXTRACTION_JSON, usage: { in: 100, out: 50, usd: 0 } };
    });

    const results = await extract(
      [{ index: 0, text: 'chunk one' }, { index: 1, text: 'chunk two' }],
      llm,
      budget,
      10.0,
      // extractProfile omitted (default), concurrency omitted (default 1)
    );

    expect(chatSpy).toHaveBeenCalledTimes(2);
    expect(callOrder).toEqual([0, 1]); // strictly sequential — chunk 0 fully done before chunk 1 starts
    expect(results.length).toBe(2);
  });

  it('concurrency > 1 processes chunks out of dispatch order but preserves result order by chunk index', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        const userText = msgs.find(m => m.role === 'user')?.content ?? '';
        const delayMs = userText.includes('slow') ? 15 : 0;
        await new Promise(r => setTimeout(r, delayMs));
        return { text: VALID_EXTRACTION_JSON, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test-model', latency_ms: 0 }; },
    };

    const results = await extract(
      [
        { index: 0, text: 'slow chunk' },
        { index: 1, text: 'fast chunk' },
      ],
      llm,
      budget,
      10.0,
      'engineering',
      2,
    );

    // Both resolve to the same VALID_EXTRACTION_JSON payload here — the
    // meaningful assertion is that index 0's result is in slot 0 regardless
    // of which chunk's LLM call actually finished first.
    expect(results[0]?.chunkIndex).toBe(0);
    expect(results[1]?.chunkIndex).toBe(1);
  });

  it('budget-stop: once one chunk hits BudgetExceeded, extract() rejects with it and stops dispatching further chunks', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const capUsd = 0; // even one chunk's estimate exceeds this
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(): Promise<ChatResult> {
        throw new Error('provider.chat should not be called when cap is 0');
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test-model', latency_ms: 0 }; },
    };
    const chunks = [0, 1, 2, 3, 4].map(i => ({ index: i, text: `chunk ${i}` }));

    await expect(extract(chunks, llm, budget, capUsd, 'engineering', 2)).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it('setting concurrency explicitly to 1 is the documented safety valve — identical results/order to the default', async () => {
    const dbA = openDb(':memory:');
    migrate(dbA);
    const dbB = openDb(':memory:');
    migrate(dbB);
    const budgetA = new BudgetTracker(dbA);
    const budgetB = new BudgetTracker(dbB);
    const chunks = [{ index: 0, text: 'chunk one' }, { index: 1, text: 'chunk two' }];

    const withDefault = await extract(chunks, makeMockLLM([VALID_EXTRACTION_JSON, VALID_EXTRACTION_JSON]), budgetA, 10.0);
    const withExplicitOne = await extract(
      chunks, makeMockLLM([VALID_EXTRACTION_JSON, VALID_EXTRACTION_JSON]), budgetB, 10.0, 'engineering', 1,
    );

    expect(withExplicitOne).toEqual(withDefault);
  });
});

// chunk-retry-amplification fix: worker.ts retries a FAILED job at the JOB
// level by re-invoking runPipeline() (and therefore extract()) from scratch.
// Without checkpointing, one transient failure (rate limit, or a stochastic
// JSON parse failure) on a late chunk replayed every earlier chunk's LLM
// call too. See the parallel test in 04-compact.test.ts for the full
// incident write-up.
describe('extract() retry checkpointing (chunk-retry-amplification fix)', () => {
  it('a retried extract() call with the same jobKey does not re-issue LLM calls for chunks that already succeeded', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const jobKey = 'session-hash-xyz789';
    const chunks = Array.from({ length: 20 }, (_, i) => ({ index: i, text: `chunk ${i} content` }));

    let callCount = 0;
    let rateLimitFired = false;
    const RATE_LIMIT_AT_INDEX = 14;
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        callCount++;
        const userText = msgs.find(m => m.role === 'user')?.content ?? '';
        const idx = Number(userText.match(/chunk (\d+) content/)?.[1]);
        if (idx === RATE_LIMIT_AT_INDEX && !rateLimitFired) {
          rateLimitFired = true;
          throw new Error('rate limited (429)');
        }
        return { text: VALID_EXTRACTION_JSON, usage: { in: 100, out: 50, usd: 0 } };
      },
      async health(): Promise<LLMHealth> { return { ok: true, model: 'test-model', latency_ms: 0 }; },
    };

    await expect(extract(chunks, llm, budget, 10.0, 'engineering', 1, jobKey)).rejects.toThrow('rate limited');
    expect(callCount).toBe(RATE_LIMIT_AT_INDEX + 1);

    const callsAfterFirstAttempt = callCount;

    const results = await extract(chunks, llm, budget, 10.0, 'engineering', 1, jobKey);

    const callsOnRetry = callCount - callsAfterFirstAttempt;
    expect(callsOnRetry).toBe(chunks.length - RATE_LIMIT_AT_INDEX); // 6, not 20
    expect(results.length).toBe(20);
    expect(results.map(r => r.chunkIndex)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it('omitting jobKey preserves the old behavior — every call re-dispatches every chunk', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON]);
    const chatSpy = vi.spyOn(llm, 'chat');
    const chunks = [{ index: 0, text: 'chunk one' }, { index: 1, text: 'chunk two' }];

    await extract(chunks, llm, budget, 10.0); // no jobKey
    expect(chatSpy).toHaveBeenCalledTimes(2);
    await extract(chunks, llm, budget, 10.0); // no jobKey — no caching, full re-dispatch
    expect(chatSpy).toHaveBeenCalledTimes(4);
  });
});

// Temporal-grounding fix (2026-07-13, WS1 of the LoCoMo score-improvement
// plan — see docs/specs/20260713-locomo-architect-design.md Workstream 1).
// 0/191 memories in the first scored LoCoMo run contained an absolute date;
// every date-bearing memory was an unresolved relative expression
// ("yesterday", "last year") with nothing anchoring it. Root cause:
// PipelineContext.capturedAtMs reached stage 8 (embed-index) but was never
// threaded one call deeper into stage 5 (extract) — the LLM writing atom
// text had no anchor to resolve relative dates against. This suite proves
// the plumbing: (a) the anchor actually reaches the LLM call as an
// "Observation date: <date>" line, (b) when a (simulated) compliant model
// resolves a relative expression against that anchor, the resolved absolute
// date survives unmangled through parsing/validation into the final atom
// text — the actual date arithmetic is the model's job (prompt-level
// resolution, per the architect design's rejection of a deterministic
// post-pass), not something a unit test with a mock LLM can validate in
// isolation — and (c) the negative case: with no anchor available, the user
// message is byte-identical to pre-fix (no injected line, relative phrasing
// left untouched) — no hallucinated date.
//
// WS4 correction (2026-07-13): the mock below originally had the "correctly
// following" model resolve dates to ISO-8601 ("2023-05-14"). That was wrong,
// proven against the real full-sample LoCoMo run and the real scorer, not
// asserted on faith: 115/321 temporal answers in that run were bare ISO
// dates, 93% of which scored EXACTLY 0 — including cases where the date was
// exactly right (`"2023-05-07"` vs gold `"7 May 2023"` = 0.0) — because
// scripts/eval/locomo/judge/metrics.mts's normalizeAnswer strips ALL
// punctuation including hyphens, collapsing "2023-05-14" into one glued
// token ("20230514") that shares nothing with a gold answer's word tokens.
// `text` is prose a person or another model reads later, not the
// machine-parsed `valid_at`/`invalid_at` columns (which correctly stay
// ISO-8601, untouched by this fix) — natural-language dates in `text` score
// correctly AND read better independent of any benchmark. The extraction
// prompt (src/distill/prompts/extract.ts) now says so explicitly; this mock
// is updated to match what a compliant model should now produce.
describe('sessionDateIso temporal grounding (2026-07-13 fix)', () => {
  /**
   * A mock LLM that plays the role of a model correctly following the
   * date-grounding rule: it reads the "Observation date: <date>" line (if
   * present) out of the user message, and if the chunk text contains one of
   * a few known relative-date phrases, emits an atom whose text has that
   * phrase replaced by the resolved absolute date IN NATURAL-LANGUAGE FORM
   * (e.g. "14 May 2023", not "2023-05-14" — see the WS4 correction note
   * above this describe block for why ISO-8601 in `text` is wrong, not just
   * a style choice). This is deliberately NOT testing the real LLM's
   * ability to do the date arithmetic (that's prompt-engineering territory,
   * validated by the full-sample LoCoMo rerun) — it's testing that our
   * plumbing (a) actually delivers the anchor to the call and (b) does not
   * corrupt/drop a correctly-resolved atom on the way back out.
   */
  function makeDateGroundingLLM(): { llm: LLMProvider; userMessages: string[] } {
    const userMessages: string[] = [];
    const RELATIVE_PHRASES: Record<string, (anchor: Date) => string> = {
      yesterday: (anchor) => naturalDate(new Date(anchor.getTime() - 24 * 60 * 60 * 1000)),
      'last week': (anchor) => naturalDate(new Date(anchor.getTime() - 7 * 24 * 60 * 60 * 1000)),
      'last year': (anchor) => `${anchor.getUTCFullYear() - 1}`,
      'three years ago': (anchor) => `${anchor.getUTCFullYear() - 3}`,
    };
    const MONTH_NAMES = [
      'January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December',
    ];
    function naturalDate(d: Date): string {
      return `${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
    }
    const llm: LLMProvider = {
      name: 'ollama' as const,
      model: 'test-model',
      async chat(msgs: ChatMsg[]): Promise<ChatResult> {
        const userMsg = msgs.find((m) => m.role === 'user')?.content ?? '';
        userMessages.push(userMsg);

        const anchorMatch = userMsg.match(/^Observation date: (\d{4}-\d{2}-\d{2})/);
        const anchor = anchorMatch ? new Date(`${anchorMatch[1]}T00:00:00.000Z`) : null;

        let text = 'Caroline attended an LGBTQ support group yesterday, which she found meaningful.';
        for (const [phrase, resolve] of Object.entries(RELATIVE_PHRASES)) {
          if (userMsg.includes(phrase)) {
            text = anchor
              ? `Caroline attended an LGBTQ support group on ${resolve(anchor)}, which she found meaningful.`
              : `Caroline attended an LGBTQ support group ${phrase}, which she found meaningful.`;
            break;
          }
        }

        return {
          text: JSON.stringify({ atoms: [{ type: 'fact', text, importance: 0.5, confidence: 0.8 }] }),
          usage: { in: 100, out: 50, usd: 0 },
        };
      },
      async health(): Promise<LLMHealth> {
        return { ok: true, model: 'test-model', latency_ms: 0 };
      },
    };
    return { llm, userMessages };
  }

  it('threads sessionDateIso into the user message as an "Observation date: <date>" line', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, userMessages } = makeDateGroundingLLM();

    await extractChunk(0, 'Caroline went to a support group yesterday.', llm, budget, 10.0, 'conversational', '2023-05-15');

    expect(userMessages[0]).toMatch(/^Observation date: 2023-05-15\n\n/);
  });

  it('anchor 2023-05-15 + "yesterday" → resolved atom text contains "14 May 2023" (natural-language, not ISO)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm } = makeDateGroundingLLM();

    const result = await extractChunk(
      0, 'Caroline went to a support group yesterday.', llm, budget, 10.0, 'conversational', '2023-05-15',
    );

    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0]!.text).toContain('14 May 2023');
    expect(result.atoms[0]!.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('anchor 2023-05-15 + "last week" → resolved atom text contains "8 May 2023" (natural-language, not ISO)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm } = makeDateGroundingLLM();

    const result = await extractChunk(
      0, 'Caroline went last week.', llm, budget, 10.0, 'conversational', '2023-05-15',
    );

    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0]!.text).toContain('8 May 2023');
    expect(result.atoms[0]!.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('anchor 2023-05-15 + "last year" → resolved atom text contains 2022', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm } = makeDateGroundingLLM();

    const result = await extractChunk(
      0, 'Melanie painted it last year.', llm, budget, 10.0, 'conversational', '2023-05-15',
    );

    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0]!.text).toContain('2022');
  });

  it('anchor 2023-05-15 + "three years ago" → resolved atom text contains 2020', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm } = makeDateGroundingLLM();

    const result = await extractChunk(
      0, 'It happened three years ago.', llm, budget, 10.0, 'conversational', '2023-05-15',
    );

    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0]!.text).toContain('2020');
  });

  // Negative case (AC-6): with no anchor available, behavior is unchanged —
  // no injected line, no hallucinated date, original relative phrasing kept.
  it('with no sessionDateIso, the user message has no "Observation date" line and relative phrasing is left untouched', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, userMessages } = makeDateGroundingLLM();

    const result = await extractChunk(
      0, 'Caroline went to a support group yesterday.', llm, budget, 10.0, 'conversational',
      // sessionDateIso omitted
    );

    expect(userMessages[0]).not.toMatch(/Observation date/);
    expect(userMessages[0]).toBe(
      'Extract knowledge atoms from this transcript chunk:\n\nCaroline went to a support group yesterday.',
    );
    expect(result.atoms.length).toBe(1);
    expect(result.atoms[0]!.text).toContain('yesterday');
    expect(result.atoms[0]!.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('extract() threads sessionDateIso through to every chunk, same as extractProfile', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const { llm, userMessages } = makeDateGroundingLLM();

    await extract(
      [{ index: 0, text: 'chunk one yesterday' }, { index: 1, text: 'chunk two last week' }],
      llm,
      budget,
      10.0,
      'conversational',
      1,
      undefined,
      '2023-05-15',
    );

    expect(userMessages).toHaveLength(2);
    for (const msg of userMessages) {
      expect(msg).toMatch(/^Observation date: 2023-05-15\n\n/);
    }
  });

  // AC-5 (2026-07-13 timezone-offset fix, closing a gap the #189 reviewer
  // found): an anchor being present must never cause a date to be stamped
  // into an atom whose source chunk carries no relative-date expression at
  // all. A stray injected date is noise in the only field the LoCoMo
  // answerer (and every recall path) actually reads — worse than doing
  // nothing. This exercises our own plumbing, not the real LLM's judgment:
  // the mock plays a model that correctly leaves text alone when there's
  // nothing to ground, and the assertion is that OUR code passes that text
  // through byte-for-byte rather than mechanically appending/injecting the
  // anchor date itself.
  it('AC-5: anchor present + chunk with no relative-date expression → atom text passes through unchanged, no date stamped', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const budget = new BudgetTracker(db);
    const llm = makeMockLLM([VALID_EXTRACTION_JSON]);

    const result = await extractChunk(
      0,
      'We decided to use sqlite-vec for vector storage in v1. Port 7777 is the default.',
      llm,
      budget,
      10.0,
      'engineering',
      '2023-05-15',
    );

    expect(result.atoms).toHaveLength(2);
    expect(result.atoms[0]!.text).toBe('use sqlite-vec for vector storage in v1');
    expect(result.atoms[1]!.text).toBe('port 7777 is the default daemon port');
    for (const atom of result.atoms) {
      expect(atom.text).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    }
  });
});
