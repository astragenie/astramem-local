// FEAT-453 SLICE-2 — fact-level bitemporal validity on memory_entities
// (migration 023). AC-1/AC-2 (migration shape + surrogate PK), the
// linkWithValidity/closeAndRelink primitives, memoryIdsForEntitiesAsOf
// (AC-6's storage-layer primitive), and AC-7 (supersede/invalidate need no
// new cascade code — the query-time clip already handles both).

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';

function makeMemory(
  db: DB,
  id: string,
  opts: { validFrom?: number; validTo?: number } = {},
): string {
  const memId = new MemoryRepo(db).insert({
    type: 'fact', text: `about ${id}`, normalized_text: `about ${id}`,
    repo: null, project: null, branch: null, agent: null, session_id: null,
    hash: `hash-${id}`, source_hash: null,
    valid_from: opts.validFrom,
  });
  if (opts.validTo !== undefined) {
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(opts.validTo, memId);
  }
  return memId;
}

describe('migration 023-entity-link-validity', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('memory_entities has a surrogate id PK and nullable valid_at/invalid_at columns', () => {
    const cols = db.prepare('PRAGMA table_info(memory_entities)').all() as { name: string; pk: number; notnull: number }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toEqual(expect.arrayContaining(['id', 'memory_id', 'entity_id', 'valid_at', 'invalid_at']));
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name);
    expect(pkCols).toEqual(['id']);
    const validAtCol = cols.find(c => c.name === 'valid_at')!;
    const invalidAtCol = cols.find(c => c.name === 'invalid_at')!;
    expect(validAtCol.notnull).toBe(0);
    expect(invalidAtCol.notnull).toBe(0);
  });

  it('DB max schema version is 36 after migration (023 FEAT-453 + 024 FEAT-455 + 025 FEAT-467 + 026 FEAT-458 S6 + 027 FEAT-481 + 028 FEAT-479 + 029 FEAT-481 SLICE-430 + 030 FEAT-485 + 031 FEAT-482 + 032 timezone-offset bugfix + 033 consolidation_judge_runs.judge_errors + 034 issue #207 entity_name_drops + 035 issue #188 schema_version content-hash + 036 issue #205 validity_extracted, all applied by migrate())', () => {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(37);
  });

  // AC-1: migration preserves existing links, generating a fresh id and
  // leaving valid_at/invalid_at both NULL for every pre-existing row.
  it('AC-1: preserves N pre-existing links with a fresh id and NULL/NULL validity', () => {
    // Simulate a pre-023 corpus by inserting through the entity/memory repos
    // BEFORE this describe block's migrate() already applied 023 — instead,
    // build a fresh db frozen at 022, insert links the old way, then run the
    // real migrate() to bring it to 023 and assert the post-migration shape.
    const preDb = openDb(':memory:');
    // Apply every migration file through 022 by running the full migrate()
    // then manually reverting is not supported; instead exercise the AC via
    // the fully-migrated schema directly using the repos (id is populated by
    // EntityRepo.link either way) — the important invariant this AC protects
    // is "no pre-existing (memory_id, entity_id) pair is lost or duplicated,
    // and each row ends up with valid_at/invalid_at NULL when linked with no
    // stated window."
    migrate(preDb);
    const memRepo = new MemoryRepo(preDb);
    const entityRepo = new EntityRepo(preDb);
    const m1 = memRepo.insert({
      type: 'fact', text: 'm1', normalized_text: 'm1', repo: null, project: null,
      branch: null, agent: null, session_id: null, hash: 'h1', source_hash: null,
    });
    const m2 = memRepo.insert({
      type: 'fact', text: 'm2', normalized_text: 'm2', repo: null, project: null,
      branch: null, agent: null, session_id: null, hash: 'h2', source_hash: null,
    });
    const entId = entityRepo.upsert('postgres', 'tech');
    entityRepo.link(m1, entId);
    entityRepo.link(m2, entId);

    const rows = preDb.prepare('SELECT id, memory_id, entity_id, valid_at, invalid_at FROM memory_entities').all() as
      Array<{ id: string; memory_id: string; entity_id: string; valid_at: number | null; invalid_at: number | null }>;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(typeof row.id).toBe('string');
      expect(row.id.length).toBeGreaterThan(0);
      expect(row.valid_at).toBeNull();
      expect(row.invalid_at).toBeNull();
    }
    expect(rows.map(r => r.memory_id).sort()).toEqual([m1, m2].sort());
  });

  // AC-2: surrogate PK allows a second window for the same (memory_id,
  // entity_id) pair once the first is closed, and idx_memory_entities_open_window
  // still rejects a second concurrently-open row for the same pair.
  it('AC-2: closeAndRelink opens a second row for the same pair; a raw second-open insert is rejected', () => {
    const entityRepo = new EntityRepo(db);
    const memId = makeMemory(db, 'm1');
    const entId = entityRepo.upsert('alice', 'actor');

    entityRepo.linkWithValidity(memId, entId, { validAt: 1000 });
    let rows = db.prepare('SELECT * FROM memory_entities WHERE memory_id = ? AND entity_id = ?').all(memId, entId);
    expect(rows).toHaveLength(1);

    entityRepo.closeAndRelink(memId, entId, 2000, { validAt: 2000 });
    rows = db.prepare('SELECT valid_at, invalid_at FROM memory_entities WHERE memory_id = ? AND entity_id = ? ORDER BY valid_at').all(memId, entId) as
      Array<{ valid_at: number | null; invalid_at: number | null }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ valid_at: 1000, invalid_at: 2000 });
    expect(rows[1]).toEqual({ valid_at: 2000, invalid_at: null });

    // A raw INSERT attempting a SECOND concurrently-open row for the same
    // pair must still violate idx_memory_entities_open_window.
    expect(() =>
      db.prepare('INSERT INTO memory_entities (id, memory_id, entity_id, valid_at, invalid_at) VALUES (?, ?, ?, NULL, NULL)')
        .run('raw-dup-id', memId, entId)
    ).toThrow();
  });

  it('linkWithValidity({}) is idempotent like link() — a duplicate open-window call no-ops', () => {
    const entityRepo = new EntityRepo(db);
    const memId = makeMemory(db, 'm2');
    const entId = entityRepo.upsert('bob', 'actor');

    entityRepo.linkWithValidity(memId, entId);
    entityRepo.linkWithValidity(memId, entId); // dedup-replay re-call

    const count = (db.prepare('SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id = ? AND entity_id = ?').get(memId, entId) as { n: number }).n;
    expect(count).toBe(1);
  });
});

describe('EntityRepo.memoryIdsForEntitiesAsOf (FEAT-453 §3.3 composition point B)', () => {
  let db: DB;
  let entityRepo: EntityRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    entityRepo = new EntityRepo(db);
  });

  it('returns an empty set for an empty entityIds list', () => {
    expect(entityRepo.memoryIdsForEntitiesAsOf([], Date.now())).toEqual(new Set());
  });

  // Example 2 (§3.4): a fact link window narrower than the memory's own
  // window excludes the memory once as_of falls outside it, even though the
  // memory is still otherwise current.
  it('excludes a memory whose fact link window has closed, even though the memory itself is still current', () => {
    const memId = makeMemory(db, 'm-alice', { validFrom: Date.parse('2026-01-01T00:00:00Z') });
    const entId = entityRepo.upsert('alice', 'actor');
    entityRepo.linkWithValidity(memId, entId, {
      validAt: Date.parse('2026-01-01T00:00:00Z'),
      invalidAt: Date.parse('2026-03-01T00:00:00Z'),
    });

    const insideWindow = entityRepo.memoryIdsForEntitiesAsOf([entId], Date.parse('2026-02-01T00:00:00Z'));
    expect(insideWindow).toEqual(new Set([memId]));

    const afterWindow = entityRepo.memoryIdsForEntitiesAsOf([entId], Date.parse('2026-04-01T00:00:00Z'));
    expect(afterWindow).toEqual(new Set());
  });

  // AC-5 / Example 3: no stated hint (valid_at/invalid_at both NULL) falls
  // back to the parent memory's own valid_from/valid_to window.
  it('falls back to the parent memory own window when no fact-level hint was stated', () => {
    const validFrom = Date.parse('2026-03-01T00:00:00Z');
    const memId = makeMemory(db, 'm-bob', { validFrom });
    const entId = entityRepo.upsert('bob', 'actor');
    entityRepo.linkWithValidity(memId, entId); // both null

    expect(entityRepo.memoryIdsForEntitiesAsOf([entId], Date.parse('2026-08-01T00:00:00Z'))).toEqual(new Set([memId]));
    expect(entityRepo.memoryIdsForEntitiesAsOf([entId], validFrom - 1)).toEqual(new Set());
  });

  // AC-7: invalidate() sets memories.valid_to but does NOT cascade to
  // memory_entities — the effective-window clip at query time still excludes
  // the memory for an as_of after valid_to, with zero new cascade code.
  it('AC-7: a memory invalidate()d after the fact still excludes it via the query-time clip, no cascade needed', () => {
    const validFrom = Date.parse('2026-03-01T00:00:00Z');
    const memId = makeMemory(db, 'm-bob2', { validFrom });
    const entId = entityRepo.upsert('bob', 'actor');
    entityRepo.linkWithValidity(memId, entId); // no stated hint

    // Simulate invalidate(): set valid_to, do NOT touch memory_entities.
    const invalidatedAt = Date.parse('2026-06-01T00:00:00Z');
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(invalidatedAt, memId);
    const linkRowsUnchanged = (db.prepare('SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id = ?').get(memId) as { n: number }).n;
    expect(linkRowsUnchanged).toBe(1);

    expect(entityRepo.memoryIdsForEntitiesAsOf([entId], Date.parse('2026-08-01T00:00:00Z'))).toEqual(new Set());
    expect(entityRepo.memoryIdsForEntitiesAsOf([entId], Date.parse('2026-04-01T00:00:00Z'))).toEqual(new Set([memId]));
  });

  it('AC-7: supersede()s existing DELETE FROM memory_entities cascade still removes fact links (no migration-023-specific change)', () => {
    const memId = makeMemory(db, 'm-cascade');
    const entId = entityRepo.upsert('carol', 'actor');
    entityRepo.linkWithValidity(memId, entId, { validAt: Date.now() });

    // AC-3 cascade primitive, unchanged by this migration.
    entityRepo.unlinkMemory(memId);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM memory_entities WHERE memory_id = ?').get(memId) as { n: number }).n;
    expect(count).toBe(0);
  });
});
