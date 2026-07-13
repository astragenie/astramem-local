import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { embedAndIndex } from '../../src/distill/stages/08-embed-index.js';
import type { NormalizedMemory } from '../../src/distill/stages/07-memory-normalize.js';
import type { EmbedProvider, EmbedHealth } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { defaultConfig } from '../../src/config/config.js';

// AC-7: capture what the gate actually logs (via a mocked childLogger)
// instead of asserting on source-code shape — proves the redacted text, not
// the raw candidate, is what reaches the (mocked) log sink.
const { warnCalls } = vi.hoisted(() => ({
  warnCalls: [] as Array<{ fields: Record<string, unknown>; msg: string }>,
}));
vi.mock('../../src/log/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/log/logger.js')>();
  return {
    ...actual,
    childLogger: () => ({
      warn: (fields: Record<string, unknown>, msg: string) => { warnCalls.push({ fields, msg }); },
      info: () => {},
    }),
  };
});

function makeVec(seed: number): Float32Array {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed + i * 0.01);
  return v;
}

function makeMockEmbed(dim: number = 1024): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'test-embed-model',
    dim: 1024 as const,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => makeVec(i + 1));
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-embed-model', dim };
    },
  };
}

function normalizedMem(
  text: string,
  hash: string,
  importance = 0.7,
  entities?: NormalizedMemory['entities'],
  relations?: NormalizedMemory['relations'],
): NormalizedMemory {
  return {
    type: 'decision',
    text,
    normalizedText: text.trim().toLowerCase(),
    importance,
    confidence: 0.8,
    contentHash: hash.slice(0, 16),
    finalHash: hash,
    evidence: undefined,
    entities,
    relations,
  };
}

describe('embedAndIndex stage', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('inserts a memory and creates a vec row', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('use sqlite-vec for v1', 'a'.repeat(64))];

    const results = await embedAndIndex(mems, {
      db,
      embed,
      sessionId: null,
      repo: 'astramemory-local',
      project: null,
      branch: null,
      agent: null,
      sourceHash: null,
    });

    expect(results.length).toBe(1);
    expect(results[0].created).toBe(true);
    expect(typeof results[0].memoryId).toBe('string');

    // Verify row in memories table
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(results[0].memoryId) as any;
    expect(row).toBeTruthy();
    expect(row.embedding_provider).toBe('ollama');
    expect(row.embedding_model).toBe('test-embed-model');
    expect(row.embedding_dim).toBe(1024);

    // Verify vec row exists
    const vecRow = db.prepare('SELECT rowid FROM memories_vec WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').get(results[0].memoryId) as any;
    expect(vecRow).toBeTruthy();
  });

  it('deduplicates by hash — second insert returns created=false', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('same memory text', 'b'.repeat(64))];

    const r1 = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });
    const r2 = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    expect(r1[0].created).toBe(true);
    expect(r2[0].created).toBe(false);
    expect(r1[0].memoryId).toBe(r2[0].memoryId);
  });

  it('handles multiple memories in a batch', async () => {
    const embed = makeMockEmbed();
    const mems = [
      normalizedMem('first decision', 'c'.repeat(64)),
      normalizedMem('second fact', 'd'.repeat(64)),
      normalizedMem('third lesson', 'e'.repeat(64)),
    ];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    expect(results.length).toBe(3);
    expect(results.every(r => r.created)).toBe(true);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n;
    expect(count).toBe(3);
  });

  it('returns empty array for empty input', async () => {
    const embed = makeMockEmbed();
    const results = await embedAndIndex([], { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });
    expect(results).toEqual([]);
  });

  it('attaches session and repo metadata', async () => {
    const embed = makeMockEmbed();
    // Need a session row first for FK
    db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run('sess-1', Date.now());

    const mems = [normalizedMem('architecture decision', 'f'.repeat(64))];
    const results = await embedAndIndex(mems, {
      db, embed,
      sessionId: 'sess-1',
      repo: 'my-repo',
      project: 'my-project',
      branch: 'main',
      agent: 'claude-code',
      sourceHash: 'src123',
    });

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(results[0].memoryId) as any;
    expect(row.session_id).toBe('sess-1');
    expect(row.repo).toBe('my-repo');
    expect(row.agent).toBe('claude-code');
  });

  // FEAT-455 / ADR-012 decision 4 — provenance tag threads to the inserted row.
  it('sets memories.capture_source when ctx.captureSource is "auto_capture"', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('auto-captured decision', 'c'.repeat(64))];
    const results = await embedAndIndex(mems, {
      db, embed,
      sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      captureSource: 'auto_capture',
    });
    const row = db.prepare('SELECT capture_source FROM memories WHERE id = ?').get(results[0].memoryId) as { capture_source: string | null };
    expect(row.capture_source).toBe('auto_capture');
  });

  it('leaves memories.capture_source NULL when ctx.captureSource is omitted (byte-identical default)', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('manually captured decision', 'd'.repeat(64))];
    const results = await embedAndIndex(mems, {
      db, embed,
      sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });
    const row = db.prepare('SELECT capture_source FROM memories WHERE id = ?').get(results[0].memoryId) as { capture_source: string | null };
    expect(row.capture_source).toBeNull();
  });

  // FEAT-402 AC-1 — entities emitted alongside an atom are linked at index time.
  it('links entities emitted on the atom to the inserted memory', async () => {
    const embed = makeMockEmbed();
    const mems = [
      normalizedMem('use Postgres for the analytics store', 'g'.repeat(64), 0.7, [
        { name: 'Postgres', kind: 'tech' },
      ]),
    ];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    const linked = new EntityRepo(db).listForMemory(results[0].memoryId);
    expect(linked).toHaveLength(1);
    expect(linked[0].name).toBe('postgres'); // AC-9 normalized
    expect(linked[0].kind).toBe('tech');
  });

  it('a memory with no entities creates no memory_entities rows', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('a fact with no named entity', 'h'.repeat(64))];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    const linked = new EntityRepo(db).listForMemory(results[0].memoryId);
    expect(linked).toEqual([]);
  });

  it('a re-ingest of a case-variant entity name resolves to the same entities.id', async () => {
    const embed = makeMockEmbed();
    const mems = [
      normalizedMem('use postgres for storage', 'i'.repeat(64), 0.7, [{ name: 'postgres', kind: 'tech' }]),
      normalizedMem('another Postgres decision', 'j'.repeat(64), 0.7, [{ name: 'Postgres', kind: 'tech' }]),
    ];

    await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    const count = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as any).n;
    expect(count).toBe(1);
  });

  // FEAT-453 AC-4 — a stated validity hint on an extracted entity is parsed
  // to epoch ms and lands on the memory_entities row via linkWithValidity.
  it('AC-4: an entity with a stated valid_at/invalid_at hint links with the parsed window', async () => {
    const embed = makeMockEmbed();
    const mems = [
      normalizedMem('Alice was the approver from January to March', 's'.repeat(64), 0.7, [
        { name: 'Alice', kind: 'actor', subtype: 'human', valid_at: '2026-01-01T00:00:00.000Z', invalid_at: '2026-03-01T00:00:00.000Z' },
      ]),
    ];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    const row = db.prepare('SELECT valid_at, invalid_at FROM memory_entities WHERE memory_id = ?').get(results[0].memoryId) as
      { valid_at: number | null; invalid_at: number | null };
    expect(row.valid_at).toBe(Date.parse('2026-01-01T00:00:00.000Z'));
    expect(row.invalid_at).toBe(Date.parse('2026-03-01T00:00:00.000Z'));
  });

  // FEAT-453 AC-5 — no stated hint links with valid_at/invalid_at both NULL
  // (never defaulted to captured_at/now), resolving to the parent memory's
  // own valid_from at query time (design doc §3.1).
  it('AC-5: an entity with no stated validity hint links with valid_at/invalid_at both NULL', async () => {
    const embed = makeMockEmbed();
    const mems = [
      normalizedMem('Bob is mentioned with no stated date', 't'.repeat(64), 0.7, [
        { name: 'Bob', kind: 'actor', subtype: 'human' },
      ]),
    ];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    const row = db.prepare('SELECT valid_at, invalid_at FROM memory_entities WHERE memory_id = ?').get(results[0].memoryId) as
      { valid_at: number | null; invalid_at: number | null };
    expect(row.valid_at).toBeNull();
    expect(row.invalid_at).toBeNull();
  });

  it('an unparseable validity hint falls back to NULL rather than throwing', async () => {
    const embed = makeMockEmbed();
    const mems = [
      normalizedMem('a fact with a garbage date hint', 'u'.repeat(64), 0.7, [
        { name: 'Carol', kind: 'actor', valid_at: 'not-a-date' },
      ]),
    ];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    const row = db.prepare('SELECT valid_at, invalid_at FROM memory_entities WHERE memory_id = ?').get(results[0].memoryId) as
      { valid_at: number | null; invalid_at: number | null };
    expect(row.valid_at).toBeNull();
    expect(row.invalid_at).toBeNull();
  });

  // FEAT-441: durability quality gate wired as a second continue-style filter
  // at the real persist site, same ordering position as the ADR-006
  // erasure-replay filter immediately above it in 08-embed-index.ts.
  describe('durability gate (FEAT-441)', () => {
    // memory#659 evidence set: 6 low-durability atoms (one extra
    // ephemeral_state sample, per AC-1's "plus one more of the same class")
    // + 1 durable decision-with-rationale atom.
    const EVIDENCE_SET: Array<{ text: string; hashSeed: string; expectedReason: string | null }> = [
      { text: 'Trunk status is green.', hashSeed: 'k1', expectedReason: 'ephemeral_state' },
      { text: 'A task is currently running.', hashSeed: 'k2', expectedReason: 'ephemeral_state' },
      { text: 'Commit a589551 fixed the prod tag deploy blocker.', hashSeed: 'k3', expectedReason: 'git_derivable' },
      { text: 'No token handling identified in the auth module.', hashSeed: 'k4', expectedReason: 'vacuous_negative' },
      { text: 'Run memory test', hashSeed: 'k5', expectedReason: 'bare_todo' },
      { text: 'src/distill/stages/08-embed-index.ts:84', hashSeed: 'k6', expectedReason: 'path_fragment' },
      {
        text: 'Chose PostgreSQL over MongoDB as the canonical store because of team ACID familiarity and existing tooling — mirrors ADR-001.',
        hashSeed: 'k7',
        expectedReason: null,
      },
    ];

    function evidenceSetMems(): NormalizedMemory[] {
      return EVIDENCE_SET.map(e => normalizedMem(e.text, e.hashSeed.repeat(64).slice(0, 64)));
    }

    // AC-1: strict mode gates the 6 low-durability atoms (each with the
    // correct gatedReason) and persists the 1 durable atom with a real id.
    it('AC-1: strict mode gates 6/7 evidence-set atoms with correct reasons, persists the 1 durable atom', async () => {
      const embed = makeMockEmbed();
      const gatedOutCounter = { count: 0 };
      const results = await embedAndIndex(evidenceSetMems(), {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'strict',
        gatedOutCounter,
      });

      expect(gatedOutCounter.count).toBe(6);
      expect(results).toHaveLength(1);
      expect(typeof results[0].memoryId).toBe('string');

      const row = db.prepare('SELECT text FROM memories WHERE id = ?').get(results[0].memoryId) as any;
      expect(row.text).toContain('Chose PostgreSQL over MongoDB');

      // Every gated atom's row must be absent from the store entirely.
      const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n;
      expect(count).toBe(1);
    });

    // AC-2: gate off (the shipped default, including when the field is
    // simply omitted) is byte-identical — all 7 atoms persist, no atom is
    // ever classified/gated.
    it('AC-2: gate off (default) persists all 7 atoms — byte-identical to pre-FEAT-441', async () => {
      const embed = makeMockEmbed();
      const gatedOutCounter = { count: 0 };
      const results = await embedAndIndex(evidenceSetMems(), {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'off',
        gatedOutCounter,
      });

      expect(gatedOutCounter.count).toBe(0);
      expect(results).toHaveLength(7);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n;
      expect(count).toBe(7);
    });

    it('AC-2: omitting durabilityGateMode entirely behaves exactly like "off"', async () => {
      const embed = makeMockEmbed();
      const results = await embedAndIndex(evidenceSetMems(), {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        // durabilityGateMode intentionally omitted
      });

      expect(results).toHaveLength(7);
    });

    // AC-2 (normalizedText/finalHash parity): the gate only decides whether
    // an atom reaches insertWithCreateEvent — it must never mutate the
    // normalize/hash stage's output. Compare the persisted row's
    // normalized_text/hash against the input NormalizedMemory field values
    // for the one atom common to both an off-run and a strict-run (the
    // durable atom, which persists in both).
    it('AC-2: normalizedText/finalHash for a persisted atom are identical whether the gate is on or off', async () => {
      const embed = makeMockEmbed();
      const durableMem = normalizedMem(
        'Chose PostgreSQL over MongoDB as the canonical store because of team ACID familiarity and existing tooling — mirrors ADR-001.',
        'z'.repeat(64),
      );

      const dbOff = openDb(':memory:');
      migrate(dbOff);
      const offResults = await embedAndIndex([durableMem], {
        db: dbOff, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'off',
      });
      const offRow = dbOff.prepare('SELECT normalized_text, hash FROM memories WHERE id = ?').get(offResults[0].memoryId) as any;

      const dbStrict = openDb(':memory:');
      migrate(dbStrict);
      const strictResults = await embedAndIndex([durableMem], {
        db: dbStrict, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'strict',
      });
      const strictRow = dbStrict.prepare('SELECT normalized_text, hash FROM memories WHERE id = ?').get(strictResults[0].memoryId) as any;

      expect(strictRow.normalized_text).toBe(offRow.normalized_text);
      expect(strictRow.hash).toBe(offRow.hash);
      expect(strictRow.normalized_text).toBe(durableMem.normalizedText);
      expect(strictRow.hash).toBe(durableMem.finalHash);
    });

    // AC-7: the logged text for a gated atom has already passed through the
    // same Stage-0 redaction path /remember and ingest use — a secret
    // matching a configured custom pattern must never reach the log sink
    // in the clear, even though the atom itself is never persisted.
    it('AC-7: a gated atom containing a secret is redacted before it reaches the log sink', async () => {
      warnCalls.length = 0;
      const embed = makeMockEmbed();
      const secretText = 'Run memory test TESTSECRET-99999'; // bare_todo shape (imperative, <=8 words, no rationale)
      const mem = normalizedMem(secretText, 'm'.repeat(64));
      const redactConfig = {
        ...defaultConfig(),
        security: {
          ...defaultConfig().security,
          redaction: { enabled: true, entropyThreshold: 4.0, customPatterns: ['TESTSECRET-\\d+'] },
        },
      };

      const results = await embedAndIndex([mem], {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'strict',
        redactConfig,
      });

      expect(results).toHaveLength(0); // gated, never persisted
      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].fields.gatedReason).toBe('bare_todo');
      const loggedText = warnCalls[0].fields.text as string;
      expect(loggedText).not.toContain('TESTSECRET-99999');
      expect(loggedText).toContain('[REDACTED:custom:');
    });

    it('AC-7: redaction falls back to defaultConfig() (redaction ON) when redactConfig is omitted', async () => {
      warnCalls.length = 0;
      const embed = makeMockEmbed();
      const mem = normalizedMem('Run memory test', 'n'.repeat(64));

      await embedAndIndex([mem], {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'strict',
        // redactConfig intentionally omitted
      });

      expect(warnCalls).toHaveLength(1);
      expect(warnCalls[0].fields.gatedReason).toBe('bare_todo');
    });

    // AC-4: gatedOutCounter is the observability out-param the caller
    // (distill/pipeline.ts) reads back to populate gatedOutCount in both
    // the structured job log and the PipelineResult digest.
    it('AC-4: gatedOutCounter accumulates once per gated atom, unaffected by dedup/erasure skips', async () => {
      const embed = makeMockEmbed();
      const gatedOutCounter = { count: 0 };
      const mems = [
        normalizedMem('Run memory test', 'p'.repeat(64)),
        normalizedMem('Trunk status is green.', 'q'.repeat(64)),
        normalizedMem('a durable fact about the architecture', 'r'.repeat(64)),
      ];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'strict',
        gatedOutCounter,
      });

      expect(gatedOutCounter.count).toBe(2);
      expect(results).toHaveLength(1);
    });
  });

  // FEAT-481 (SLICE-2/SLICE-435): relation triples resolved to entity ids
  // and persisted via EntityRelationRepo at the same site entities are
  // linked (design doc §2.3 "resolveAtomRelations ... at stage 8").
  describe('entity_relations wiring (FEAT-481)', () => {
    it('persists a relation with correctly resolved entity ids and evidence_memory_id', async () => {
      const embed = makeMockEmbed();
      const mems = [
        normalizedMem(
          'astramemory-local uses SQLite for storage',
          'v'.repeat(64),
          0.8,
          [
            { name: 'astramemory-local', kind: 'project' },
            { name: 'SQLite', kind: 'tech' },
          ],
          [{ subject: 'astramemory-local', predicate: 'uses', object: 'SQLite', confidence: 0.9 }],
        ),
      ];

      const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

      const entityRepo = new EntityRepo(db);
      const rows = db.prepare('SELECT * FROM entity_relations').all() as Array<{
        subject_entity_id: string; predicate: string; object_entity_id: string;
        evidence_memory_id: string; source_excerpt: string; confidence: number;
      }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.predicate).toBe('uses');
      expect(rows[0]!.evidence_memory_id).toBe(results[0]!.memoryId);
      expect(rows[0]!.confidence).toBe(0.9);

      const linked = entityRepo.listForMemory(results[0]!.memoryId);
      const subjEntity = linked.find(e => e.name === 'astramemory-local');
      const objEntity = linked.find(e => e.name === 'sqlite');
      expect(rows[0]!.subject_entity_id).toBe(subjEntity!.id);
      expect(rows[0]!.object_entity_id).toBe(objEntity!.id);
    });

    it('falls back to the atom evidence, then text, for source_excerpt when the relation omits one', async () => {
      const embed = makeMockEmbed();
      const mems = [
        normalizedMem(
          'astramemory-local uses SQLite for storage',
          'w'.repeat(64),
          0.8,
          [{ name: 'astramemory-local', kind: 'project' }, { name: 'SQLite', kind: 'tech' }],
          [{ subject: 'astramemory-local', predicate: 'uses', object: 'SQLite' }], // no evidence
        ),
      ];

      await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

      const row = db.prepare('SELECT source_excerpt, confidence FROM entity_relations').get() as
        { source_excerpt: string; confidence: number };
      expect(row.source_excerpt).toBe('astramemory-local uses SQLite for storage');
      // confidence falls back to the atom's own confidence (0.8, the helper default)
      expect(row.confidence).toBe(0.8);
    });

    it('a memory with no relations creates no entity_relations rows', async () => {
      const embed = makeMockEmbed();
      const mems = [normalizedMem('a fact with no relation', 'x'.repeat(64), 0.7, [{ name: 'Alice', kind: 'actor' }])];

      await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

      const count = (db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    // Re-ingest / dedup: EntityRelationRepo.insert's atomic INSERT...SELECT
    // WHERE NOT EXISTS guard (SLICE-427) means a re-distilled duplicate atom
    // resolves to the SAME entity ids (via entities.name UNIQUE) and the
    // dedup guard skips the second insert.
    it('re-ingesting the identical atom+relation does not create a duplicate entity_relations row', async () => {
      const embed = makeMockEmbed();
      const mem = normalizedMem(
        'astramemory-local uses SQLite for storage',
        'y'.repeat(64),
        0.8,
        [{ name: 'astramemory-local', kind: 'project' }, { name: 'SQLite', kind: 'tech' }],
        [{ subject: 'astramemory-local', predicate: 'uses', object: 'SQLite', confidence: 0.9 }],
      );

      // First ingest.
      await embedAndIndex([mem], { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });
      // Second ingest of the exact same atom (same hash -> dedup at the
      // memories layer, but entity_relations.insert is exercised again with
      // the SAME resolved entity ids since entities.name is UNIQUE).
      await embedAndIndex([mem], { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

      const count = (db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get() as { n: number }).n;
      expect(count).toBe(1);
    });

    it('a relation whose entity somehow fails to resolve is skipped without throwing (defensive)', async () => {
      const embed = makeMockEmbed();
      // Construct a NormalizedMemory bypassing stage-5's filter (which would
      // normally have dropped this) to exercise stage 8's own defensive
      // fallback — an unresolvable relation must not crash the whole insert.
      const mems = [
        normalizedMem(
          'a fact naming only one entity',
          'z2'.repeat(32),
          0.7,
          [{ name: 'Alice', kind: 'actor' }],
          [{ subject: 'Alice', predicate: 'relates_to', object: 'Bob' }], // "Bob" never in entities[]
        ),
      ];

      await expect(
        embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null }),
      ).resolves.toBeTruthy();

      const count = (db.prepare('SELECT COUNT(*) AS n FROM entity_relations').get() as { n: number }).n;
      expect(count).toBe(0);
    });

    // FEAT-481 SLICE-430 (review fix, MEDIUM): recordRelationGuardDrops is a
    // DIAGNOSTIC write, invoked here after every real stage-8 write (memory
    // insert, entity link, vec upsert) has already succeeded. Dropping
    // relation_guard_drops out from under it forces a real SqliteError
    // ("no such table") on that call — proves stage 8's own try/catch
    // swallows it (logged, not thrown) rather than letting a diagnostic
    // failure invalidate an already-successful embed-index call.
    it('a relation_guard_drops write failure does not fail embedAndIndex — the memory still persists', async () => {
      db.exec('DROP TABLE relation_guard_drops');
      warnCalls.length = 0;
      const embed = makeMockEmbed();
      const mems = [
        normalizedMem(
          'a fact naming only one entity',
          'z3'.repeat(32),
          0.7,
          [{ name: 'Alice', kind: 'actor' }],
          [{ subject: 'Alice', predicate: 'relates_to', object: 'Bob' }], // "Bob" never in entities[] -> unresolvable_at_write drop
        ),
      ];

      const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

      expect(results).toHaveLength(1);
      expect(results[0]!.created).toBe(true);
      const mem = db.prepare('SELECT id FROM memories WHERE id = ?').get(results[0]!.memoryId);
      expect(mem).toBeDefined();

      // The mocked childLogger (module-level vi.mock above) captured the
      // swallowed failure instead of it propagating.
      expect(warnCalls.some(c => c.msg.includes('relation guard-drop counter write failed'))).toBe(true);
    });
  });
});
