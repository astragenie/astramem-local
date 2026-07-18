/**
 * FEAT-552 sub-scope B (AC-B2): runTypeBackfillBatch core logic —
 * src/distill/backfill-types.ts. Mirrors the seeding pattern
 * tests/consolidate/consolidate-knn.test.ts already established
 * (MemoryRepo.insert + SqliteVecStore.upsert) so this exercises a REAL
 * memories_vec row, not a stub.
 */
import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { runTypeBackfillBatch } from '../../src/distill/backfill-types.js';
import { normalizeText } from '../../src/distill/stages/07-memory-normalize.js';

const DIM = 1024;

function fakeVec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed * (i + 1));
  return v;
}

async function seed(
  db: DB, text: string, hash: string, type: string, seedNum: number,
): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: type as 'fact', text, normalized_text: text,
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
  await new SqliteVecStore(db, DIM).upsert(id, fakeVec(seedNum));
  return id;
}

/** Seeds `normalized_text` via the REAL normalizeText() (ENTITY_DICT
 *  canonicalization applied), matching what the distill pipeline actually
 *  stores — unlike `seed()` above, which stores the raw text verbatim as a
 *  shortcut for candidates that don't interact with ENTITY_DICT. Needed for
 *  the bun/vitest case-order regression below: normalized_text is what
 *  runTypeBackfillBatch actually reads. */
async function seedNormalized(
  db: DB, text: string, hash: string, type: string, seedNum: number,
): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: type as 'fact', text, normalized_text: normalizeText(text),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
  await new SqliteVecStore(db, DIM).upsert(id, fakeVec(seedNum));
  return id;
}

function memoriesRow(db: DB, id: string) {
  return db.prepare('SELECT rowid, type, hash, updated_at FROM memories WHERE id = ?').get(id) as {
    rowid: number; type: string; hash: string; updated_at: number;
  };
}

function vecRow(db: DB, rowid: number) {
  return db.prepare('SELECT rowid, embedding FROM memories_vec WHERE rowid = ?').get(BigInt(rowid)) as
    { rowid: number; embedding: Buffer } | undefined;
}

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db, DIM);
  return db;
}

describe('runTypeBackfillBatch — AC-B2', () => {
  it('dry-run computes the would-change census with zero mutation', async () => {
    const db = setupDb();
    const events = new MemoryEventRepo(db);
    const decisionId = await seed(db, 'Use SQLite instead of Postgres for local storage.', 'h1', 'fact', 1);
    const alreadyCorrectId = await seed(db, 'Cap retries at 5 attempts rather than retrying forever.', 'h2', 'decision', 2);
    const noSignalId = await seed(db, 'some ordinary text with no strong signal', 'h3', 'fact', 3);

    const before = memoriesRow(db, decisionId);

    const result = runTypeBackfillBatch(db, events, { apply: false, batchSize: 100 });

    expect(result.scanned).toBe(3);
    expect(result.changed).toBe(0);
    expect(result.census).toEqual({ fact: { decision: 1 } });
    const candidate = result.candidates.find(c => c.id === decisionId);
    expect(candidate).toMatchObject({ fromType: 'fact', toType: 'decision', applied: false });

    // Nothing mutated.
    const after = memoriesRow(db, decisionId);
    expect(after.type).toBe('fact');
    expect(after.updated_at).toBe(before.updated_at);
    expect(events.listForAtom(decisionId)).toEqual([]);

    // Sanity: the already-correct and no-signal atoms produced no candidates.
    expect(result.candidates.some(c => c.id === alreadyCorrectId)).toBe(false);
    expect(result.candidates.some(c => c.id === noSignalId)).toBe(false);
  });

  // Regression (review finding, 2026-07-18): normalized_text is what this
  // module reads (never raw text) — and normalizeText()'s ENTITY_DICT
  // capitalizes bare "bun" -> "Bun" before this code ever sees it. A
  // case-sensitive command regex would silently never detect this
  // candidate. Uses seedNormalized() (real normalizeText() output), not the
  // seed() shortcut, so this actually exercises the same column value
  // production writes.
  it('detects a bun-led command atom stored via the real normalizeText() output ("Bun", not "bun")', async () => {
    const db = setupDb();
    const events = new MemoryEventRepo(db);
    const id = await seedNormalized(db, 'bun run test', 'h-bun', 'fact', 41);

    const row = db.prepare('SELECT normalized_text FROM memories WHERE id = ?').get(id) as { normalized_text: string };
    expect(row.normalized_text).toBe('Bun run test'); // confirms ENTITY_DICT ran, same as production

    const result = runTypeBackfillBatch(db, events, { apply: true, batchSize: 100 });
    expect(result.changed).toBe(1);
    expect(memoriesRow(db, id).type).toBe('command');
  });

  it('--apply mutates memories.type and appends a type_corrected audit event, never touching text/hash/vec', async () => {
    const db = setupDb();
    const events = new MemoryEventRepo(db);
    const id = await seed(db, 'Use SQLite instead of Postgres for local storage.', 'h-apply', 'fact', 7);

    const beforeRow = memoriesRow(db, id);
    const beforeVec = vecRow(db, beforeRow.rowid);
    expect(beforeVec).toBeDefined();

    const result = runTypeBackfillBatch(db, events, { apply: true, batchSize: 100 });

    expect(result.changed).toBe(1);
    const afterRow = memoriesRow(db, id);
    expect(afterRow.type).toBe('decision');
    // content_hash (hash column) is byte-identical — never touched.
    expect(afterRow.hash).toBe(beforeRow.hash);
    // updated_at DID advance (a real mutation happened).
    expect(afterRow.updated_at).toBeGreaterThanOrEqual(beforeRow.updated_at);

    // vec row is completely untouched — same rowid, same embedding bytes.
    const afterVec = vecRow(db, afterRow.rowid);
    expect(afterVec).toBeDefined();
    expect(afterVec!.rowid).toBe(beforeVec!.rowid);
    expect(Buffer.compare(afterVec!.embedding, beforeVec!.embedding)).toBe(0);

    // Audit event: correction-style, tagged type-backfill, NOT the
    // memory_corrected negative-usefulness family.
    const atomEvents = events.listForAtom(id);
    expect(atomEvents.length).toBe(1);
    expect(atomEvents[0]!.event_type).toBe('usefulness');
    const payload = JSON.parse(atomEvents[0]!.payload_json!);
    expect(payload).toMatchObject({
      family: 'type_corrected',
      action: 'retype',
      from: 'fact',
      to: 'decision',
      source: 'type-backfill',
    });
    expect(payload.family).not.toBe('memory_corrected');
  });

  it('is resumable via lastRowid — two small batches cover exactly what one big batch does', async () => {
    const db = setupDb();
    const events = new MemoryEventRepo(db);
    const id1 = await seed(db, 'Use SQLite instead of Postgres for local storage.', 'r1', 'fact', 11);
    const id2 = await seed(db, 'Cap retries at 5 attempts rather than retrying forever.', 'r2', 'fact', 12);
    const id3 = await seed(db, 'Migrate to pino incrementally rather than a big-bang rewrite.', 'r3', 'fact', 13);

    // Batch 1: only the first row.
    const batch1 = runTypeBackfillBatch(db, events, { apply: true, batchSize: 1, startAfterRowid: 0 });
    expect(batch1.scanned).toBe(1);
    expect(batch1.exhausted).toBe(false);
    expect(memoriesRow(db, id1).type).toBe('decision');
    expect(memoriesRow(db, id2).type).toBe('fact'); // not reached yet
    expect(memoriesRow(db, id3).type).toBe('fact'); // not reached yet

    // Batch 2: resumes from batch1.lastRowid, picks up the remaining two.
    const batch2 = runTypeBackfillBatch(db, events, { apply: true, batchSize: 100, startAfterRowid: batch1.lastRowid });
    expect(batch2.scanned).toBe(2);
    expect(batch2.exhausted).toBe(true);
    expect(memoriesRow(db, id2).type).toBe('decision');
    expect(memoriesRow(db, id3).type).toBe('decision');

    // Combined effect matches changing all 3 in one pass.
    expect(batch1.changed + batch2.changed).toBe(3);

    // A THIRD call starting from batch2's checkpoint finds nothing left —
    // idempotent resume, not a re-application.
    const batch3 = runTypeBackfillBatch(db, events, { apply: true, batchSize: 100, startAfterRowid: batch2.lastRowid });
    expect(batch3.scanned).toBe(0);
    expect(batch3.changed).toBe(0);
    expect(batch3.exhausted).toBe(true);
  });

  it('skips invalidated (valid_to set) rows — a superseded atom is never retyped', async () => {
    const db = setupDb();
    const events = new MemoryEventRepo(db);
    const id = await seed(db, 'Use SQLite instead of Postgres for local storage.', 'h-inv', 'fact', 21);
    events.invalidate(id);

    const result = runTypeBackfillBatch(db, events, { apply: true, batchSize: 100 });
    expect(result.scanned).toBe(0);
    expect(result.changed).toBe(0);
    expect(memoriesRow(db, id).type).toBe('fact');
  });

  it('re-running --apply on an already-backfilled corpus is a pure no-op (idempotent)', async () => {
    const db = setupDb();
    const events = new MemoryEventRepo(db);
    await seed(db, 'Use SQLite instead of Postgres for local storage.', 'h-idem', 'fact', 31);

    const first = runTypeBackfillBatch(db, events, { apply: true, batchSize: 100 });
    expect(first.changed).toBe(1);

    const second = runTypeBackfillBatch(db, events, { apply: true, batchSize: 100 });
    expect(second.changed).toBe(0);
    expect(second.candidates).toEqual([]);
  });
});
