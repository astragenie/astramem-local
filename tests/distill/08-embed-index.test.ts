import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { embedAndIndex } from '../../src/distill/stages/08-embed-index.js';
import type { NormalizedMemory } from '../../src/distill/stages/07-memory-normalize.js';
import type { EmbedProvider, EmbedHealth, LLMProvider, ChatMsg, ChatOpts } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { defaultConfig } from '../../src/config/config.js';
import { ATOM_TRIAGE_MARKER, CORRECTED_TYPE_CONFIDENCE_GATE, type TriageVerdictLabel } from '../../src/distill/atom-triage.js';
import type { MemoryType } from '../../src/contracts/index.js';

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
  evidence?: string,
): NormalizedMemory {
  return {
    type: 'decision',
    text,
    normalizedText: text.trim().toLowerCase(),
    importance,
    confidence: 0.8,
    contentHash: hash.slice(0, 16),
    finalHash: hash,
    evidence,
    entities,
    relations,
  };
}

/**
 * Issue #209: a real, DB-level vec-upsert failure — an embed provider whose
 * declared dim (999) matches its own vector length (so the earlier "embed
 * provider invariant violation" guard and SqliteVecStore's own length check
 * both pass) but MISMATCHES the memories_vec table's actual schema dim
 * (FLOAT[1024], the DEFAULT_EMBED_DIM baked in by migrate() with no dim
 * argument). The INSERT INTO memories_vec itself then throws a real
 * dimension-mismatch error from the sqlite-vec extension — the same shape of
 * failure a provider swap mid-fleet would produce, not a mocked exception.
 */
function makeMismatchedDimEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'bad-dim-model',
    dim: 999 as const,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => {
        const v = new Float32Array(999);
        for (let j = 0; j < 999; j++) v[j] = Math.sin(i + j * 0.01);
        return v;
      });
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'bad-dim-model', dim: 999 };
    },
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
    expect(results[0]!.created).toBe(true);
    expect(typeof results[0]!.memoryId).toBe('string');

    // Verify row in memories table
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(results[0]!.memoryId) as any;
    expect(row).toBeTruthy();
    expect(row.embedding_provider).toBe('ollama');
    expect(row.embedding_model).toBe('test-embed-model');
    expect(row.embedding_dim).toBe(1024);

    // Verify vec row exists
    const vecRow = db.prepare('SELECT rowid FROM memories_vec WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').get(results[0]!.memoryId) as any;
    expect(vecRow).toBeTruthy();
  });

  it('deduplicates by hash — second insert returns created=false', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('same memory text', 'b'.repeat(64))];

    const r1 = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });
    const r2 = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    expect(r1[0]!.created).toBe(true);
    expect(r2[0]!.created).toBe(false);
    expect(r1[0]!.memoryId).toBe(r2[0]!.memoryId);
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

  // Issue #209: "a failed vec-upsert returns ok:true and is never retried" —
  // 13 production memories were unrecallable by vector search, permanently,
  // with a green write. This proves the fix at the data-path level: the
  // memory still persists (the atom is never lost over an indexing failure),
  // the failure is durably recorded (not just an ephemeral response field),
  // and a retry is actually queued (not just an alarm).
  describe('vec upsert failure (issue #209)', () => {
    it('a vec-upsert failure does not fail embedAndIndex — the memory persists, needs_vec_index is set, a reembed job is enqueued', async () => {
      const embed = makeMismatchedDimEmbed();
      const mems = [normalizedMem('a memory whose vec upsert will fail', 'vecfail'.repeat(8).slice(0, 64))];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      });

      // The memory itself is NOT lost — a vec-index failure must never
      // reject content the caller asked to save.
      expect(results).toHaveLength(1);
      expect(results[0]!.created).toBe(true);

      const memRepo = new MemoryRepo(db);
      const memory = memRepo.get(results[0]!.memoryId);
      expect(memory).toBeTruthy();
      // Durable retry marker — the previous behavior had NOTHING durable
      // here; the failure lived only in a log line.
      expect(memory!.needs_vec_index).toBe(true);

      // No memories_vec row exists for this memory (the upsert genuinely failed).
      const vecRow = db.prepare(
        'SELECT rowid FROM memories_vec WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)',
      ).get(results[0]!.memoryId);
      expect(vecRow).toBeUndefined();

      // A retry, not just an alarm: a `reembed` job was actually enqueued.
      const jobs = db.prepare("SELECT payload_json FROM jobs WHERE kind = 'reembed'").all() as { payload_json: string }[];
      expect(jobs).toHaveLength(1);
      expect(JSON.parse(jobs[0]!.payload_json)).toMatchObject({ kind: 'reembed', memory_id: results[0]!.memoryId });
    });

    it('one atom failing vec upsert does not abort the rest of the batch', async () => {
      const embed = makeMismatchedDimEmbed();
      const mems = [
        normalizedMem('first atom, vec upsert will fail', 'vf1'.repeat(22).slice(0, 64)),
        normalizedMem('second atom, vec upsert will also fail', 'vf2'.repeat(22).slice(0, 64)),
      ];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      });

      // Both atoms persisted — before this fix, the second atom's insert
      // would never even run because the first atom's vec upsert threw
      // straight out of the loop.
      expect(results).toHaveLength(2);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
      expect(count).toBe(2);
    });
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

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(results[0]!.memoryId) as any;
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
    const row = db.prepare('SELECT capture_source FROM memories WHERE id = ?').get(results[0]!.memoryId) as { capture_source: string | null };
    expect(row.capture_source).toBe('auto_capture');
  });

  it('leaves memories.capture_source NULL when ctx.captureSource is omitted (byte-identical default)', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('manually captured decision', 'd'.repeat(64))];
    const results = await embedAndIndex(mems, {
      db, embed,
      sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });
    const row = db.prepare('SELECT capture_source FROM memories WHERE id = ?').get(results[0]!.memoryId) as { capture_source: string | null };
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

    const linked = new EntityRepo(db).listForMemory(results[0]!.memoryId);
    expect(linked).toHaveLength(1);
    expect(linked[0]!.name).toBe('postgres'); // AC-9 normalized
    expect(linked[0]!.kind).toBe('tech');
  });

  it('a memory with no entities creates no memory_entities rows', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('a fact with no named entity', 'h'.repeat(64))];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    const linked = new EntityRepo(db).listForMemory(results[0]!.memoryId);
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

    const row = db.prepare('SELECT valid_at, invalid_at FROM memory_entities WHERE memory_id = ?').get(results[0]!.memoryId) as
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

    const row = db.prepare('SELECT valid_at, invalid_at FROM memory_entities WHERE memory_id = ?').get(results[0]!.memoryId) as
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

    const row = db.prepare('SELECT valid_at, invalid_at FROM memory_entities WHERE memory_id = ?').get(results[0]!.memoryId) as
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
      expect(typeof results[0]!.memoryId).toBe('string');

      const row = db.prepare('SELECT text FROM memories WHERE id = ?').get(results[0]!.memoryId) as any;
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
      const offRow = dbOff.prepare('SELECT normalized_text, hash FROM memories WHERE id = ?').get(offResults[0]!.memoryId) as any;

      const dbStrict = openDb(':memory:');
      migrate(dbStrict);
      const strictResults = await embedAndIndex([durableMem], {
        db: dbStrict, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        durabilityGateMode: 'strict',
      });
      const strictRow = dbStrict.prepare('SELECT normalized_text, hash FROM memories WHERE id = ?').get(strictResults[0]!.memoryId) as any;

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
      expect(warnCalls[0]!.fields.gatedReason).toBe('bare_todo');
      const loggedText = warnCalls[0]!.fields.text as string;
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
      expect(warnCalls[0]!.fields.gatedReason).toBe('bare_todo');
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

  // FEAT-551: evidence-gated sweeper — stage-8 admission gate for passB
  // (dual-pass "specifics sweeper") atoms in the mixed-provider case.
  describe('evidence gate (FEAT-551)', () => {
    const TRANSCRIPT = 'we are NOT using Redis for the session store\nplain in-process LRU cache for now';

    function sourcedMem(
      text: string,
      hash: string,
      extractionSource: 'passA' | 'passB' | undefined,
      evidence?: string,
    ): NormalizedMemory {
      return { ...normalizedMem(text, hash), extractionSource, evidence };
    }

    // AC-1: a passB atom with no evidence field is dropped, counted, logged
    // with reason 'no-evidence-field' — never silent.
    it("AC-1: passB atom with no evidence field is dropped pre-index — reason 'no-evidence-field'", async () => {
      warnCalls.length = 0;
      const embed = makeMockEmbed();
      const mems = [sourcedMem('a passB fact with no evidence', 'a'.repeat(64), 'passB')];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        evidenceGateEnabled: true,
        sourceText: TRANSCRIPT,
      });

      expect(results).toHaveLength(0);
      const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n;
      expect(count).toBe(0);
      const gateWarn = warnCalls.find(w => w.msg.includes('evidence gate'));
      expect(gateWarn?.fields.reason).toBe('no-evidence-field');

      // Persistence (review fix): the drop must be a real DB row, not just
      // an in-memory counter — evidence_gate_drops/evidence_gate_run_log are
      // the tables a future doctor canary or the AC-5 measurement lane reads.
      const dropRows = db.prepare('SELECT reason, count, session_id FROM evidence_gate_drops').all() as any[];
      expect(dropRows).toHaveLength(1);
      expect(dropRows[0].reason).toBe('no-evidence-field');
      expect(dropRows[0].count).toBe(1);
      expect(dropRows[0].session_id).toBeNull();
      const runLog = db.prepare('SELECT atoms_attempted, atoms_dropped FROM evidence_gate_run_log').get() as any;
      expect(runLog.atoms_attempted).toBe(1);
      expect(runLog.atoms_dropped).toBe(1);
    });

    // AC-1: a passB atom whose evidence does NOT mechanically verify against
    // the transcript is dropped with the distinct 'evidence-not-found' reason.
    it("AC-1: passB atom with a non-verifying evidence quote is dropped — reason 'evidence-not-found'", async () => {
      warnCalls.length = 0;
      const embed = makeMockEmbed();
      const mems = [
        sourcedMem('a fabricated passB fact', 'b'.repeat(64), 'passB', 'we definitely ARE using Redis'),
      ];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        evidenceGateEnabled: true,
        sourceText: TRANSCRIPT,
      });

      expect(results).toHaveLength(0);
      const gateWarn = warnCalls.find(w => w.msg.includes('evidence gate'));
      expect(gateWarn?.fields.reason).toBe('evidence-not-found');

      // Persistence (review fix): distinct reason, its own DB row.
      const dropRows = db.prepare('SELECT reason, count FROM evidence_gate_drops').all() as any[];
      expect(dropRows).toHaveLength(1);
      expect(dropRows[0].reason).toBe('evidence-not-found');
      expect(dropRows[0].count).toBe(1);
      const runLog = db.prepare('SELECT atoms_attempted, atoms_dropped FROM evidence_gate_run_log').get() as any;
      expect(runLog.atoms_attempted).toBe(1);
      expect(runLog.atoms_dropped).toBe(1);
    });

    // AC-1: a passB atom whose evidence DOES verify (whitespace-normalized)
    // is admitted normally.
    it('AC-1: passB atom with a real verbatim evidence quote is admitted', async () => {
      const embed = makeMockEmbed();
      const mems = [
        sourcedMem('a real passB fact', 'c'.repeat(64), 'passB', 'we are NOT using   Redis   for the session store'),
      ];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        evidenceGateEnabled: true,
        sourceText: TRANSCRIPT,
      });

      expect(results).toHaveLength(1);
      const row = db.prepare('SELECT text FROM memories WHERE id = ?').get(results[0]!.memoryId) as any;
      expect(row.text).toBe('a real passB fact');

      // Persistence (review fix): an admitted atom is still ATTEMPTED (rate
      // denominator), just not dropped — evidence_gate_drops stays empty.
      expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_gate_drops').get() as any).n).toBe(0);
      const runLog = db.prepare('SELECT atoms_attempted, atoms_dropped FROM evidence_gate_run_log').get() as any;
      expect(runLog.atoms_attempted).toBe(1);
      expect(runLog.atoms_dropped).toBe(0);
    });

    // AC-2: pass-A atoms are NEVER gated, regardless of evidence or gate
    // setting — this is the exact "byte-identical" bypass the FEAT requires.
    it('AC-2: a passA atom with no evidence is admitted even with the gate ON', async () => {
      const embed = makeMockEmbed();
      const mems = [sourcedMem('a passA fact, no evidence needed', 'd'.repeat(64), 'passA')];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        evidenceGateEnabled: true,
        sourceText: TRANSCRIPT,
      });

      expect(results).toHaveLength(1);
    });

    // AC-2: gate OFF is byte-identical — even a would-fail passB atom
    // persists untouched when evidenceGateEnabled is false.
    it('AC-2: gate off — a passB atom with fabricated evidence is still admitted (byte-identical bypass)', async () => {
      const embed = makeMockEmbed();
      const mems = [
        sourcedMem('a passB fact that would fail the gate', 'e'.repeat(64), 'passB', 'never said this at all'),
      ];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        evidenceGateEnabled: false,
        sourceText: TRANSCRIPT,
      });

      expect(results).toHaveLength(1);
      // Gate off — the tables stay a real zero, no phantom row (mirrors
      // atom-triage's "mode off never writes a run-log row" posture).
      expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_gate_drops').get() as any).n).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_gate_run_log').get() as any).n).toBe(0);
    });

    // AC-2: omitting evidenceGateEnabled entirely behaves exactly like "off"
    // — every pre-FEAT-551 caller stays byte-identical.
    it('AC-2: omitting evidenceGateEnabled entirely behaves exactly like "off"', async () => {
      const embed = makeMockEmbed();
      const mems = [
        sourcedMem('a passB fact, gate field omitted entirely', 'f'.repeat(64), 'passB', 'never said this at all'),
      ];

      const results = await embedAndIndex(mems, {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        sourceText: TRANSCRIPT,
        // evidenceGateEnabled intentionally omitted
      });

      expect(results).toHaveLength(1);
    });

    // AC-2 (integration-level): mixed pass-A/pass-B batch — the gate must
    // affect ONLY the passB atoms in the SAME batch; pass-A atom count and
    // content stay identical whether the gate is on or off.
    it('AC-2: in a mixed batch, gate on/off changes only the passB atom outcome — passA atoms unaffected', async () => {
      const embed = makeMockEmbed();
      const passAMem = sourcedMem('a stable passA fact', 'g'.repeat(64), 'passA');
      const failingPassBMem = sourcedMem('a passB fact with fabricated evidence', 'h'.repeat(64), 'passB', 'never said this');

      const withGateOff = await embedAndIndex([passAMem, failingPassBMem], {
        db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        evidenceGateEnabled: false,
        sourceText: TRANSCRIPT,
      });
      expect(withGateOff).toHaveLength(2); // both admitted — gate off
      expect((db.prepare('SELECT COUNT(*) AS n FROM evidence_gate_run_log').get() as any).n).toBe(0);

      // Fresh DB for the gate-on run so dedup doesn't interfere with counting.
      const db2 = openDb(':memory:');
      migrate(db2);
      const withGateOn = await embedAndIndex([passAMem, failingPassBMem], {
        db: db2, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
        evidenceGateEnabled: true,
        sourceText: TRANSCRIPT,
      });
      expect(withGateOn).toHaveLength(1); // only the passA atom survives
      const row = db2.prepare('SELECT text FROM memories WHERE id = ?').get(withGateOn[0]!.memoryId) as any;
      expect(row.text).toBe('a stable passA fact');

      // Persistence (review fix): only the ONE passB atom counts toward the
      // attempted/dropped denominator — the passA atom in the same batch
      // never touches these tables at all.
      const runLog = db2.prepare('SELECT atoms_attempted, atoms_dropped FROM evidence_gate_run_log').get() as any;
      expect(runLog.atoms_attempted).toBe(1);
      expect(runLog.atoms_dropped).toBe(1);
      const dropRows = db2.prepare('SELECT reason FROM evidence_gate_drops').all() as any[];
      expect(dropRows).toHaveLength(1);
      expect(dropRows[0].reason).toBe('evidence-not-found');
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

// ─── FEAT-533: LLM atom-triage tier ─────────────────────────────────────────

/** Deterministic fake triage provider: routes verdicts by exact text match
 *  from `verdictByText` (missing entries default to 'keep'), same
 *  closed-table posture MOCK_EXTRACTION_VOCAB uses for extraction. Verifies
 *  the marker is present so a misrouted (non-triage) call is caught. */
/** FEAT-547: per-verdict entry may additionally carry a `corrected_type`
 *  and/or `evidence_supported` — both omitted (undefined) reproduces the
 *  pre-v2 single-verdict shape exactly, so every pre-FEAT-547 caller of
 *  this helper is unaffected. */
interface MockVerdict {
  verdict: TriageVerdictLabel;
  confidence: number;
  corrected_type?: MemoryType;
  evidence_supported?: boolean;
}

function makeTriageProvider(
  verdictByText: Record<string, MockVerdict>,
): LLMProvider {
  return {
    name: 'ollama',
    model: 'test-triage-model',
    async chat(messages: ChatMsg[], _opts?: ChatOpts) {
      const system = messages.find(m => m.role === 'system')?.content ?? '';
      if (!system.includes(ATOM_TRIAGE_MARKER)) {
        throw new Error('test provider received a non-triage call (missing ATOM_TRIAGE_MARKER)');
      }
      const user = messages.find(m => m.role === 'user')?.content ?? '';
      const verdicts: Array<{
        index: number; verdict: string; confidence: number;
        corrected_type?: string; evidence_supported?: boolean;
      }> = [];
      // FEAT-547: an atom line may carry a trailing ` [evidence: "..."]`
      // suffix (see atom-triage.ts's triageBatch userContent builder) — the
      // non-greedy text group stops before that optional suffix so a plain
      // `verdictByText` lookup by the atom's own text still matches.
      for (const line of user.split('\n')) {
        const m = line.match(/^\[(\d+)\]\s(.*?)(?:\s\[evidence: ".*"\])?$/);
        if (!m) continue;
        const index = Number(m[1]);
        const text = m[2]!;
        const v = verdictByText[text] ?? { verdict: 'keep' as const, confidence: 1 };
        verdicts.push({
          index, verdict: v.verdict, confidence: v.confidence,
          ...(v.corrected_type !== undefined ? { corrected_type: v.corrected_type } : {}),
          ...(v.evidence_supported !== undefined ? { evidence_supported: v.evidence_supported } : {}),
        });
      }
      return { text: JSON.stringify({ verdicts }), usage: { in: 1, out: 1, usd: 0 } };
    },
    async health() {
      return { ok: true, model: 'test-triage-model', latency_ms: 0 };
    },
  };
}

function makeThrowingTriageProvider(message: string): LLMProvider {
  return {
    name: 'ollama',
    model: 'unreachable-triage-model',
    async chat() {
      throw new Error(message);
    },
    async health() {
      return { ok: false, model: 'unreachable-triage-model', latency_ms: 0, error: message };
    },
  };
}

describe('embedAndIndex — cooperative yield in Phase A/Phase C atom loops (2026-07-19 event-loop-stall fix)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  function makeYieldFixtureMems(count: number): NormalizedMemory[] {
    return Array.from({ length: count }, (_, i) =>
      normalizedMem(`yield fixture atom ${i}`, `yld${i}`.padEnd(64, '0')),
    );
  }

  it('fires the yield hook in both Phase A and Phase C, every yieldEveryNAtoms atoms, counting atoms regardless of gating', async () => {
    const embed = makeMockEmbed();
    const mems = makeYieldFixtureMems(12);
    let yields = 0;

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      yieldEveryNAtoms: 5,
      onYield: () => { yields++; },
    });

    expect(results).toHaveLength(12);
    // floor(12/5) = 2 yields per loop; Phase A and Phase C both walk the same
    // 12 atoms here (nothing gated by default), so total = 2 + 2 = 4.
    expect(yields).toBe(4);
  });

  it('never yields when the batch is smaller than the interval (default interval, small batch)', async () => {
    const embed = makeMockEmbed();
    const mems = makeYieldFixtureMems(3);
    let yields = 0;

    await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      onYield: () => { yields++; }, // default interval (25), only 3 atoms in this batch
    });

    expect(yields).toBe(0);
  });

  it('yielding every single atom produces the same insert outcome as the default interval (behavior-preserving)', async () => {
    const mems = makeYieldFixtureMems(6);

    const resultsDefault = await embedAndIndex(mems, {
      db, embed: makeMockEmbed(), sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
    });

    const dbFrequentYield = openDb(':memory:');
    migrate(dbFrequentYield);
    const resultsFrequentYield = await embedAndIndex(mems, {
      db: dbFrequentYield, embed: makeMockEmbed(), sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      yieldEveryNAtoms: 1,
    });

    expect(resultsFrequentYield).toHaveLength(resultsDefault.length);
    expect(resultsFrequentYield.map(r => r.created)).toEqual(resultsDefault.map(r => r.created));

    const countDefault = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const countFrequent = (dbFrequentYield.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(countFrequent).toBe(countDefault);
  });
});

describe('embedAndIndex — FEAT-533 atom-triage tier', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it("mode 'off' (default, including omitted) never calls the triage provider — byte-identical to pre-FEAT-533", async () => {
    const embed = makeMockEmbed();
    let called = false;
    const llmAtomTriage = makeTriageProvider({});
    const wrapped: LLMProvider = { ...llmAtomTriage, chat: async (...args) => { called = true; return llmAtomTriage.chat(...args); } };
    const mems = [normalizedMem('a durable fact about the architecture', 'a'.repeat(64))];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      llmAtomTriage: wrapped,
      // atomTriageMode intentionally omitted
    });

    expect(called).toBe(false);
    expect(results).toHaveLength(1);
    expect((db.prepare('SELECT COUNT(*) AS n FROM triage_guard_drops').get() as any).n).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM triage_run_log').get() as any).n).toBe(0);
  });

  it("mode 'dry-run': every atom persists regardless of verdict, and a row is recorded per non-'keep' verdict with the real memory_id", async () => {
    const embed = makeMockEmbed();
    const junkText = 'no results found';
    const keepText = 'a durable fact about the architecture';
    const llmAtomTriage = makeTriageProvider({ [junkText]: { verdict: 'junk', confidence: 0.85 } });
    const mems = [normalizedMem(junkText, 'b'.repeat(64)), normalizedMem(keepText, 'c'.repeat(64))];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'dry-run',
      llmAtomTriage,
    });

    // Both atoms persisted — dry-run drops nothing.
    expect(results).toHaveLength(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n).toBe(2);

    const rows = db.prepare('SELECT reason, memory_id, model, confidence, mode, session_id FROM triage_guard_drops').all() as any[];
    expect(rows).toHaveLength(1);
    expect(rows[0].reason).toBe('junk');
    expect(rows[0].mode).toBe('dry-run');
    expect(rows[0].model).toBe('test-triage-model');
    expect(rows[0].confidence).toBeCloseTo(0.85);
    expect(rows[0].session_id).toBeNull();
    // memory_id is set (the atom actually persisted) — find it among the
    // junk-text result to confirm it's the SAME id embedAndIndex returned.
    const junkResultId = results.find(r => {
      const row = db.prepare('SELECT text FROM memories WHERE id = ?').get(r.memoryId) as any;
      return row?.text === junkText;
    })?.memoryId;
    expect(rows[0].memory_id).toBe(junkResultId);

    const runLog = db.prepare('SELECT atoms_triaged, atoms_dropped FROM triage_run_log').get() as any;
    expect(runLog.atoms_triaged).toBe(2);
    expect(runLog.atoms_dropped).toBe(1);
  });

  it("mode 'enabled': non-'keep' atoms are dropped (never persisted), sibling 'keep' atoms persist unchanged, drops counted by reason", async () => {
    const embed = makeMockEmbed();
    const junkText = 'no results found';
    const echoText = 'searching for prior session notes';
    const keepText = 'Chose PostgreSQL for ACID guarantees over MongoDB';
    const llmAtomTriage = makeTriageProvider({
      [junkText]: { verdict: 'junk', confidence: 0.9 },
      [echoText]: { verdict: 'meta-echo', confidence: 0.7 },
    });
    const mems = [
      normalizedMem(junkText, 'd'.repeat(64)),
      normalizedMem(echoText, 'e'.repeat(64)),
      normalizedMem(keepText, 'f'.repeat(64)),
    ];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'enabled',
      llmAtomTriage,
    });

    // Only the keep-verdict atom persisted.
    expect(results).toHaveLength(1);
    const row = db.prepare('SELECT text FROM memories WHERE id = ?').get(results[0]!.memoryId) as any;
    expect(row.text).toBe(keepText);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n).toBe(1);

    const rows = db.prepare('SELECT reason, memory_id, mode FROM triage_guard_drops ORDER BY reason').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.reason)).toEqual(['junk', 'meta-echo']);
    // Dropped atoms never reached insertWithCreateEvent — no memory_id.
    expect(rows.every(r => r.memory_id === null)).toBe(true);
    expect(rows.every(r => r.mode === 'enabled')).toBe(true);

    const runLog = db.prepare('SELECT atoms_triaged, atoms_dropped FROM triage_run_log').get() as any;
    expect(runLog.atoms_triaged).toBe(3);
    expect(runLog.atoms_dropped).toBe(2);
  });

  it('provider unreachable: fails open — every atom persists, a WARN is logged, no atom is silently dropped', async () => {
    warnCalls.length = 0;
    const embed = makeMockEmbed();
    const llmAtomTriage = makeThrowingTriageProvider('ECONNREFUSED');
    const mems = [
      normalizedMem('no results found', 'g'.repeat(64)),
      normalizedMem('a durable fact about the architecture', 'h'.repeat(64)),
    ];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'enabled',
      llmAtomTriage,
    });

    expect(results).toHaveLength(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n).toBe(2);
    expect(warnCalls.some(c => c.msg.includes('ECONNREFUSED'))).toBe(true);
    // Fail-open means nothing was classified as dropped.
    expect((db.prepare('SELECT COUNT(*) AS n FROM triage_guard_drops').get() as any).n).toBe(0);
    const runLog = db.prepare('SELECT atoms_dropped FROM triage_run_log').get() as any;
    expect(runLog.atoms_dropped).toBe(0);
  });

  it('maxPerRun cap reached: atoms in later batches fall through un-triaged and persist unfiltered (never drop-by-timeout)', async () => {
    const embed = makeMockEmbed();
    const junkText = 'no results found';
    const llmAtomTriage = makeTriageProvider({ [junkText]: { verdict: 'junk', confidence: 0.9 } });
    // batchSize 1 + maxPerRun 1 -> only the FIRST atom's batch call ever runs;
    // the second atom (also junk-worthy) is never triaged at all.
    const mems = [
      normalizedMem(junkText, 'i'.repeat(64), 0.7, undefined, undefined),
      normalizedMem(junkText.slice(0) + ' (second)', 'j'.repeat(64)),
    ];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'enabled',
      llmAtomTriage,
      atomTriageBatchSize: 1,
      atomTriageMaxPerRun: 1,
    });

    // First atom triaged+dropped; second never reached by the capped
    // tracker, so it falls through and persists.
    expect(results).toHaveLength(1);
    const persisted = db.prepare('SELECT text FROM memories').all() as any[];
    expect(persisted[0]!.text).toContain('(second)');

    const runLog = db.prepare('SELECT atoms_triaged, atoms_dropped FROM triage_run_log').get() as any;
    expect(runLog.atoms_triaged).toBe(1); // only the first batch was attempted
    expect(runLog.atoms_dropped).toBe(1);
  });

  it('the regex durability gate runs BEFORE triage — a gate-rejected atom never reaches the triage provider', async () => {
    const embed = makeMockEmbed();
    let triageCallCount = 0;
    const base = makeTriageProvider({});
    const counting: LLMProvider = { ...base, chat: async (...args) => { triageCallCount++; return base.chat(...args); } };
    const mems = [
      normalizedMem('Run memory test', 'k'.repeat(64)), // bare_todo, gated under 'strict'
      normalizedMem('a durable fact about the architecture', 'l'.repeat(64)),
    ];

    const gatedOutCounter = { count: 0 };
    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      durabilityGateMode: 'strict',
      gatedOutCounter,
      atomTriageMode: 'enabled',
      llmAtomTriage: counting,
    });

    expect(gatedOutCounter.count).toBe(1); // 'Run memory test' gated by regex
    expect(results).toHaveLength(1); // only the durable fact survives to persist
    // The triage provider only ever saw the ONE survivor, not the gated atom.
    expect(triageCallCount).toBe(1);
  });
});

// ─── FEAT-547: atom-triage v2 — corrected_type / evidence_supported ─────────

describe('embedAndIndex — FEAT-547 atom-triage v2 (corrected_type / evidence_supported)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it("mode 'enabled': a corrected_type verdict AT the confidence gate overwrites the stored type; below-gate keeps the original", async () => {
    const embed = makeMockEmbed();
    const highConfText = 'the deadline moved to next Friday';
    const lowConfText = 'the deadline is next Friday';
    const llmAtomTriage = makeTriageProvider({
      [highConfText]: { verdict: 'keep', confidence: CORRECTED_TYPE_CONFIDENCE_GATE, corrected_type: 'event' },
      [lowConfText]: { verdict: 'keep', confidence: CORRECTED_TYPE_CONFIDENCE_GATE - 0.01, corrected_type: 'event' },
    });
    const mems = [
      normalizedMem(highConfText, 'm'.repeat(64)),
      normalizedMem(lowConfText, 'n'.repeat(64)),
    ];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'enabled',
      llmAtomTriage,
    });

    expect(results).toHaveLength(2);
    const highRow = db.prepare('SELECT type FROM memories WHERE text = ?').get(highConfText) as any;
    const lowRow = db.prepare('SELECT type FROM memories WHERE text = ?').get(lowConfText) as any;
    // At-gate (>=) applies; the original NormalizedMemory.type in this test
    // fixture is 'decision' (see normalizedMem's default) — the AC-2
    // "confidence >= 0.8" wording is inclusive of the boundary itself.
    expect(highRow.type).toBe('event');
    // Below-gate: original type ('decision') is kept, corrected_type dropped.
    expect(lowRow.type).toBe('decision');
  });

  it("mode 'enabled': evidence_supported is applied as a queryable flag on the memory row, on an evidence-bearing atom only", async () => {
    const embed = makeMockEmbed();
    const supportedText = 'the team migrated to PostgreSQL for ACID guarantees';
    const unsupportedText = 'the team migrated to MongoDB for flexibility';
    const noEvidenceText = 'a durable fact about the architecture';
    const llmAtomTriage = makeTriageProvider({
      [supportedText]: { verdict: 'keep', confidence: 0.9, evidence_supported: true },
      [unsupportedText]: { verdict: 'keep', confidence: 0.9, evidence_supported: false },
    });
    const mems = [
      normalizedMem(supportedText, 'o'.repeat(64), 0.7, undefined, undefined, 'we chose PostgreSQL for ACID'),
      normalizedMem(unsupportedText, 'p'.repeat(64), 0.7, undefined, undefined, 'we chose PostgreSQL for ACID'),
      normalizedMem(noEvidenceText, 'q'.repeat(64)), // no evidence field at all
    ];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'enabled',
      llmAtomTriage,
    });

    expect(results).toHaveLength(3);
    const supportedRow = db.prepare('SELECT evidence_supported FROM memories WHERE text = ?').get(supportedText) as any;
    const unsupportedRow = db.prepare('SELECT evidence_supported FROM memories WHERE text = ?').get(unsupportedText) as any;
    const noEvidenceRow = db.prepare('SELECT evidence_supported FROM memories WHERE text = ?').get(noEvidenceText) as any;
    expect(supportedRow.evidence_supported).toBe(1);
    expect(unsupportedRow.evidence_supported).toBe(0);
    // Never atoms deleted or mutated for a false verdict — text is intact.
    expect(db.prepare('SELECT text FROM memories WHERE text = ?').get(unsupportedText)).toBeTruthy();
    // No evidence field on the atom at all -> flag stays NULL even though
    // this atom's index has no verdict entry either (defense-in-depth gate).
    expect(noEvidenceRow.evidence_supported).toBeNull();

    // Observability: both applied signals are recorded in triage_guard_drops
    // for the manually reviewed agreement sample, keyed by the real memory_id.
    const rows = db.prepare('SELECT reason, memory_id, evidence_supported FROM triage_guard_drops ORDER BY memory_id').all() as any[];
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.reason === 'keep')).toBe(true);
    expect(rows.every(r => r.memory_id !== null)).toBe(true);
  });

  it("mode 'dry-run': corrected_type and evidence_supported are LOGGED but never applied — atom persists byte-unchanged apart from the diagnostic row", async () => {
    const embed = makeMockEmbed();
    const text = 'the deadline moved to next Friday';
    const llmAtomTriage = makeTriageProvider({
      [text]: { verdict: 'keep', confidence: 0.95, corrected_type: 'event', evidence_supported: true },
    });
    const mems = [normalizedMem(text, 'r'.repeat(64), 0.7, undefined, undefined, 'the deadline moved to Friday')];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'dry-run',
      llmAtomTriage,
    });

    expect(results).toHaveLength(1);
    const row = db.prepare('SELECT type, evidence_supported FROM memories WHERE text = ?').get(text) as any;
    // Neither signal applied — dry-run rewrites nothing (AC-5).
    expect(row.type).toBe('decision');
    expect(row.evidence_supported).toBeNull();

    const logRows = db.prepare('SELECT reason, corrected_type, evidence_supported, mode, memory_id FROM triage_guard_drops').all() as any[];
    expect(logRows).toHaveLength(1);
    expect(logRows[0].reason).toBe('keep');
    expect(logRows[0].corrected_type).toBe('event');
    expect(logRows[0].evidence_supported).toBe(1);
    expect(logRows[0].mode).toBe('dry-run');
    expect(logRows[0].memory_id).toBe(results[0]!.memoryId);
  });

  it("mode 'off': no corrected_type/evidence_supported fields are ever requested or parsed — byte-identical to pre-FEAT-547 (AC-5)", async () => {
    const embed = makeMockEmbed();
    let seenUserContent = '';
    const base = makeTriageProvider({});
    const capturing: LLMProvider = {
      ...base,
      chat: async (messages, opts) => {
        seenUserContent = messages.find(m => m.role === 'user')?.content ?? '';
        return base.chat(messages, opts);
      },
    };
    const mems = [normalizedMem('a durable fact about the architecture', 's'.repeat(64), 0.7, undefined, undefined, 'some evidence')];

    const results = await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      llmAtomTriage: capturing,
      // atomTriageMode intentionally omitted -> 'off'
    });

    expect(seenUserContent).toBe(''); // provider never called at all
    expect(results).toHaveLength(1);
    const row = db.prepare('SELECT type, evidence_supported FROM memories WHERE text = ?').get('a durable fact about the architecture') as any;
    expect(row.type).toBe('decision');
    expect(row.evidence_supported).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM triage_guard_drops').get() as any).n).toBe(0);
  });

  // AC-4: a labeled fixture set with known-correct types, asserting typeAcc
  // on the GATE-APPLIED corrections directly — not just end-to-end recall.
  // Closes the exact pre-mortem gap: this test would fail if corrected_type
  // silently mis-typed a high-confidence atom, which a recall-only assertion
  // would never catch.
  it('AC-4: typeAcc over gate-applied corrected_type verdicts matches the fixture-derived expectation', async () => {
    const embed = makeMockEmbed();
    const fixture: Array<{ text: string; hash: string; originalType: NormalizedMemory['type']; verdict: MockVerdict }> = [
      { text: 'atom 1', hash: 'a1'.repeat(32), originalType: 'note', verdict: { verdict: 'keep', confidence: 0.9, corrected_type: 'decision' } }, // correct, applied
      { text: 'atom 2', hash: 'a2'.repeat(32), originalType: 'note', verdict: { verdict: 'keep', confidence: 0.85, corrected_type: 'fact' } },     // correct, applied
      { text: 'atom 3', hash: 'a3'.repeat(32), originalType: 'note', verdict: { verdict: 'keep', confidence: 0.81, corrected_type: 'event' } },    // WRONG gold is 'lesson', applied anyway (measures typeAcc, not perfection)
      { text: 'atom 4', hash: 'a4'.repeat(32), originalType: 'note', verdict: { verdict: 'keep', confidence: 0.79, corrected_type: 'todo' } },     // under-gate, never applied — excluded from typeAcc denominator
    ];
    const goldType: Record<string, MemoryType> = {
      'atom 1': 'decision', 'atom 2': 'fact', 'atom 3': 'lesson', 'atom 4': 'todo',
    };
    const verdictByText: Record<string, MockVerdict> = {};
    for (const f of fixture) verdictByText[f.text] = f.verdict;
    const llmAtomTriage = makeTriageProvider(verdictByText);
    const mems = fixture.map(f => ({ ...normalizedMem(f.text, f.hash), type: f.originalType }));

    await embedAndIndex(mems, {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'enabled',
      llmAtomTriage,
    });

    // Recompute typeAcc directly against the DB's applied `type` column —
    // ONLY over atoms whose verdict actually cleared the gate (atom 4 never
    // applied, so it is not part of the denominator).
    let applied = 0;
    let correct = 0;
    for (const f of fixture) {
      if (f.verdict.confidence < CORRECTED_TYPE_CONFIDENCE_GATE) continue;
      applied++;
      const row = db.prepare('SELECT type FROM memories WHERE text = ?').get(f.text) as any;
      if (row.type === goldType[f.text]) correct++;
    }
    expect(applied).toBe(3); // atoms 1-3 cleared the gate; atom 4 did not
    const typeAcc = correct / applied;
    expect(typeAcc).toBeCloseTo(2 / 3, 5); // atoms 1-2 correct, atom 3 wrong
  });
});

// ---------------------------------------------------------------------------
// 'repair-only' mode (2026-07-18, FEAT-547 follow-up): applies corrected_type/
// evidence_supported exactly like 'enabled' but NEVER drops an atom — the
// measured 55fx verdict split (every clerk's discard verdict costs recall:
// phi −40 / qwen3.5:4b −36 / ministral −17, while ministral's typing raises
// typeAcc 43→52) gets a mode that keeps only the half that earns.
// ---------------------------------------------------------------------------

describe("embedAndIndex — 'repair-only' atom-triage mode", () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('a junk verdict does NOT drop the atom, but its corrected_type IS applied (the defining split)', async () => {
    const embed = makeMockEmbed();
    const junkText = 'the deploy finished and everything looked fine afterwards';
    const llmAtomTriage = makeTriageProvider({
      [junkText]: { verdict: 'junk', confidence: 0.99, corrected_type: 'event' },
    });

    const results = await embedAndIndex([normalizedMem(junkText, 'r'.repeat(64))], {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'repair-only',
      llmAtomTriage,
    });

    // Atom persisted despite the high-confidence junk verdict.
    expect(results).toHaveLength(1);
    const row = db.prepare('SELECT type, text FROM memories WHERE text = ?').get(junkText) as any;
    expect(row).toBeTruthy();
    // ...and the typing half of the same verdict was applied.
    expect(row.type).toBe('event');
    // The ignored discard verdict is observable in triage_guard_drops with a
    // REAL memory_id (nothing was dropped) and mode 'repair-only'.
    const drops = db.prepare('SELECT reason, memory_id, mode FROM triage_guard_drops').all() as any[];
    expect(drops).toHaveLength(1);
    expect(drops[0].reason).toBe('junk');
    expect(drops[0].mode).toBe('repair-only');
    expect(drops[0].memory_id).not.toBeNull();
  });

  it('below-gate corrected_type keeps the original type; evidence_supported applies on evidence-bearing atoms', async () => {
    const embed = makeMockEmbed();
    const lowConfText = 'the service settings were changed at some point';
    const flagText = 'the team standardized on pnpm for workspace installs';
    const llmAtomTriage = makeTriageProvider({
      [lowConfText]: { verdict: 'keep', confidence: CORRECTED_TYPE_CONFIDENCE_GATE - 0.01, corrected_type: 'event' },
      [flagText]: { verdict: 'keep', confidence: 0.9, evidence_supported: true },
    });

    await embedAndIndex([
      normalizedMem(lowConfText, 's'.repeat(64)),
      normalizedMem(flagText, 't'.repeat(64), 0.7, undefined, undefined, 'we standardized on pnpm'),
    ], {
      db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null,
      atomTriageMode: 'repair-only',
      llmAtomTriage,
    });

    const lowRow = db.prepare('SELECT type FROM memories WHERE text = ?').get(lowConfText) as any;
    expect(lowRow.type).toBe('decision'); // fixture default kept — same confidence gate as 'enabled'
    const flagRow = db.prepare('SELECT evidence_supported FROM memories WHERE text = ?').get(flagText) as any;
    expect(flagRow.evidence_supported).toBe(1);
  });
});
