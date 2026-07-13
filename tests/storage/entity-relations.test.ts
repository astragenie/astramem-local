// FEAT-481 SLICE-1 — migration 027 schema shape (AC-1), EntityRelationRepo's
// atomic dedup guard (AC-2), the JOIN-with-memories effective-validity
// contract (AC-3), the supersede() cascade (AC-4), and the erase_memory
// ON DELETE CASCADE (AC-5). See docs/specs/FEAT-481-design.md §1/§3/§4.1.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { EntityRelationRepo, type EntityRelationInput } from '../../src/storage/entity-relations.js';

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

describe('migration 027-entity-relations (AC-1)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('creates the entity_relations table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('entity_relations');
  });

  it('has the exact column shape from the design doc', () => {
    const cols = db.prepare('PRAGMA table_info(entity_relations)').all() as
      Array<{ name: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual([
      'confidence', 'created_at', 'evidence_memory_id', 'id', 'invalidated_by',
      'object_entity_id', 'predicate', 'source_excerpt', 'subject_entity_id',
      'valid_from', 'valid_to',
    ].sort());
    expect(byName.id!.pk).toBeGreaterThan(0);
    expect(byName.subject_entity_id!.notnull).toBe(1);
    expect(byName.predicate!.notnull).toBe(1);
    expect(byName.object_entity_id!.notnull).toBe(1);
    expect(byName.evidence_memory_id!.notnull).toBe(1);
    expect(byName.source_excerpt!.notnull).toBe(1);
    expect(byName.confidence!.notnull).toBe(1);
    expect(byName.valid_from!.notnull).toBe(1);
    expect(byName.valid_to!.notnull).toBe(0);
    expect(byName.invalidated_by!.notnull).toBe(0);
    expect(byName.created_at!.notnull).toBe(1);
  });

  it('confidence defaults to 0.5 when omitted', () => {
    const memId = makeMemory(db, 'm1');
    const entityRepo = new EntityRepo(db);
    const subjId = entityRepo.upsert('alice', 'actor');
    const objId = entityRepo.upsert('bob', 'actor');
    db.prepare(`
      INSERT INTO entity_relations (id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, valid_from, created_at)
      VALUES ('r1', ?, 'owned_by', ?, ?, 'excerpt', 1000, 1000)
    `).run(subjId, objId, memId);
    const row = db.prepare('SELECT confidence FROM entity_relations WHERE id = ?').get('r1') as { confidence: number };
    expect(row.confidence).toBe(0.5);
  });

  it('has indexes on (subject_entity_id, predicate), (object_entity_id, predicate), valid_to, and evidence_memory_id', () => {
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='entity_relations'").all() as
      Array<{ sql: string | null }>;
    const sqls = indexes.map(i => i.sql ?? '');
    expect(sqls.some(s => s.includes('subject_entity_id') && s.includes('predicate'))).toBe(true);
    expect(sqls.some(s => s.includes('object_entity_id') && s.includes('predicate'))).toBe(true);
    expect(sqls.some(s => s.includes('valid_to') && !s.includes('subject_entity_id') && !s.includes('object_entity_id'))).toBe(true);
    expect(sqls.some(s => s.includes('evidence_memory_id'))).toBe(true);
  });

  it('subject_entity_id/object_entity_id/evidence_memory_id are ON DELETE CASCADE FKs, not RESTRICT', () => {
    const memId = makeMemory(db, 'm-cascade');
    const entityRepo = new EntityRepo(db);
    const subjId = entityRepo.upsert('alice', 'actor');
    const objId = entityRepo.upsert('bob', 'actor');
    db.prepare(`
      INSERT INTO entity_relations (id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, valid_from, created_at)
      VALUES ('r-cascade', ?, 'owned_by', ?, ?, 'excerpt', 1000, 1000)
    `).run(subjId, objId, memId);

    // Deleting the memory must cascade-delete the relation row, not throw an FK violation.
    expect(() => db.prepare('DELETE FROM memories WHERE id = ?').run(memId)).not.toThrow();
    expect(db.prepare('SELECT 1 FROM entity_relations WHERE id = ?').get('r-cascade')).toBeUndefined();
  });

  it('DB max schema version is 29 after migration', () => {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(29);
  });
});

describe('EntityRelationRepo.insert (AC-2 atomic dedup guard)', () => {
  let db: DB;
  let entityRepo: EntityRepo;
  let relationRepo: EntityRelationRepo;
  let subjId: string;
  let objId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    entityRepo = new EntityRepo(db);
    relationRepo = new EntityRelationRepo(db);
    subjId = entityRepo.upsert('alice', 'actor');
    objId = entityRepo.upsert('bob', 'actor');
  });

  function baseInput(memId: string, overrides: Partial<EntityRelationInput> = {}): EntityRelationInput {
    return {
      subjectEntityId: subjId,
      predicate: 'owned_by',
      objectEntityId: objId,
      evidenceMemoryId: memId,
      sourceExcerpt: 'alice owns the deploy script',
      validFrom: 1000,
      ...overrides,
    };
  }

  it('inserts a new relation and reports inserted: true', () => {
    const memId = makeMemory(db, 'm1');
    const result = relationRepo.insert(baseInput(memId));
    expect(result.inserted).toBe(true);
    const row = db.prepare('SELECT * FROM entity_relations WHERE id = ?').get(result.id);
    expect(row).toBeDefined();
  });

  it('a second memory asserting the identical currently-valid triple is skipped — at most one row survives', () => {
    const mem1 = makeMemory(db, 'm1');
    const mem2 = makeMemory(db, 'm2');

    const first = relationRepo.insert(baseInput(mem1));
    const second = relationRepo.insert(baseInput(mem2, { sourceExcerpt: 'bob is owned by alice too' }));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const count = (db.prepare(`
      SELECT COUNT(*) AS n FROM entity_relations
      WHERE subject_entity_id = ? AND predicate = ? AND object_entity_id = ?
    `).get(subjId, 'owned_by', objId) as { n: number }).n;
    expect(count).toBe(1);
  });

  it('a different predicate for the same subject/object pair is NOT deduped (distinct tuple)', () => {
    const mem1 = makeMemory(db, 'm1');
    const mem2 = makeMemory(db, 'm2');

    const first = relationRepo.insert(baseInput(mem1));
    const second = relationRepo.insert(baseInput(mem2, { predicate: 'assigned_to' }));

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
  });

  it('a closed (valid_to NOT NULL) prior row does not block a fresh insert for the same tuple', () => {
    const mem1 = makeMemory(db, 'm1');
    const mem2 = makeMemory(db, 'm2');
    const first = relationRepo.insert(baseInput(mem1));
    db.prepare('UPDATE entity_relations SET valid_to = 5000 WHERE id = ?').run(first.id);

    const second = relationRepo.insert(baseInput(mem2));
    expect(second.inserted).toBe(true);

    const count = (db.prepare(`
      SELECT COUNT(*) AS n FROM entity_relations
      WHERE subject_entity_id = ? AND predicate = ? AND object_entity_id = ?
    `).get(subjId, 'owned_by', objId) as { n: number }).n;
    expect(count).toBe(2);
  });

  it('defaults confidence to 0.5 when omitted', () => {
    const memId = makeMemory(db, 'm1');
    const result = relationRepo.insert(baseInput(memId));
    const row = db.prepare('SELECT confidence FROM entity_relations WHERE id = ?').get(result.id) as { confidence: number };
    expect(row.confidence).toBe(0.5);
  });

  it('stores an explicit confidence value', () => {
    const memId = makeMemory(db, 'm1');
    const result = relationRepo.insert(baseInput(memId, { confidence: 0.9 }));
    const row = db.prepare('SELECT confidence FROM entity_relations WHERE id = ?').get(result.id) as { confidence: number };
    expect(row.confidence).toBe(0.9);
  });
});

describe('EntityRelationRepo query surface (AC-3: JOIN-with-memories effective validity)', () => {
  let db: DB;
  let entityRepo: EntityRepo;
  let relationRepo: EntityRelationRepo;
  let events: MemoryEventRepo;
  let subjId: string;
  let objId: string;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    entityRepo = new EntityRepo(db);
    relationRepo = new EntityRelationRepo(db);
    events = new MemoryEventRepo(db);
    subjId = entityRepo.upsert('alice', 'actor');
    objId = entityRepo.upsert('bob', 'actor');
  });

  it('getForSubject returns a currently-valid relation with no asOf supplied', () => {
    const memId = makeMemory(db, 'm1');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
    });
    const rows = relationRepo.getForSubject(subjId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.predicate).toBe('owned_by');
  });

  it('getForObject returns the relation from the object side', () => {
    const memId = makeMemory(db, 'm1');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
    });
    const rows = relationRepo.getForObject(objId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject_entity_id).toBe(subjId);
  });

  it('getForEntity(direction: both) returns relations where the entity is either subject or object', () => {
    const memId = makeMemory(db, 'm1');
    const carolId = entityRepo.upsert('carol', 'actor');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
    });
    relationRepo.insert({
      subjectEntityId: carolId, predicate: 'assigned_to', objectEntityId: subjId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt2', validFrom: Date.now() - 10_000,
    });
    const rows = relationRepo.getForEntity(subjId, { direction: 'both' });
    expect(rows).toHaveLength(2);
  });

  it('getForEntity(direction: subject) restricts to only the subject role', () => {
    const memId = makeMemory(db, 'm1');
    const carolId = entityRepo.upsert('carol', 'actor');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
    });
    relationRepo.insert({
      subjectEntityId: carolId, predicate: 'assigned_to', objectEntityId: subjId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt2', validFrom: Date.now() - 10_000,
    });
    const rows = relationRepo.getForEntity(subjId, { direction: 'subject' });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.object_entity_id).toBe(objId);
  });

  // AC-3's core contract: a relation sourced from an invalidate()d memory
  // stops reading as valid once asOf passes THAT MEMORY's own valid_to,
  // even though entity_relations.valid_to itself is still NULL.
  it('excludes a relation once asOf passes its evidence memory own valid_to (via the JOIN, not entity_relations.valid_to alone)', () => {
    const validFrom = Date.parse('2026-01-01T00:00:00Z');
    const memId = makeMemory(db, 'm-invalidated', { validFrom });
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom,
    });

    // Sanity: currently valid before invalidation.
    expect(relationRepo.getForSubject(subjId, { asOf: Date.parse('2026-02-01T00:00:00Z') })).toHaveLength(1);

    events.invalidate(memId);
    const invalidatedMemory = db.prepare('SELECT valid_to FROM memories WHERE id = ?').get(memId) as { valid_to: number };
    expect(invalidatedMemory.valid_to).not.toBeNull();

    // entity_relations.valid_to is still NULL — the exclusion must come from the join.
    const relRow = db.prepare('SELECT valid_to FROM entity_relations WHERE evidence_memory_id = ?').get(memId) as { valid_to: number | null };
    expect(relRow.valid_to).toBeNull();

    const afterInvalidate = relationRepo.getForSubject(subjId, { asOf: invalidatedMemory.valid_to + 10_000 });
    expect(afterInvalidate).toHaveLength(0);

    // Still visible for an asOf strictly before the memory's own valid_to.
    const beforeInvalidate = relationRepo.getForSubject(subjId, { asOf: invalidatedMemory.valid_to - 1 });
    expect(beforeInvalidate).toHaveLength(1);
  });

  it('respects the limit parameter', () => {
    const memId = makeMemory(db, 'm1');
    const entities = ['e1', 'e2', 'e3'].map(n => entityRepo.upsert(n, 'actor'));
    for (const objEnt of entities) {
      relationRepo.insert({
        subjectEntityId: subjId, predicate: 'relates_to', objectEntityId: objEnt,
        evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
      });
    }
    expect(relationRepo.getForSubject(subjId, { limit: 2 })).toHaveLength(2);
  });
});

describe('supersede() cascade (AC-4)', () => {
  let db: DB;
  let entityRepo: EntityRepo;
  let relationRepo: EntityRelationRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    entityRepo = new EntityRepo(db);
    relationRepo = new EntityRelationRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('supersede() deletes every entity_relations row citing the old memory, in the same transaction', () => {
    const oldId = makeMemory(db, 'm-old');
    const newId = makeMemory(db, 'm-new');
    const subjId = entityRepo.upsert('alice', 'actor');
    const objId = entityRepo.upsert('bob', 'actor');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: oldId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE evidence_memory_id = ?').get(oldId)).toEqual({ n: 1 });

    events.supersede(oldId, newId);

    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE evidence_memory_id = ?').get(oldId)).toEqual({ n: 0 });
  });

  it('supersede() does not touch entity_relations rows citing a different memory', () => {
    const oldId = makeMemory(db, 'm-old2');
    const newId = makeMemory(db, 'm-new2');
    const otherId = makeMemory(db, 'm-other');
    const subjId = entityRepo.upsert('alice2', 'actor');
    const objId = entityRepo.upsert('bob2', 'actor');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: otherId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
    });

    events.supersede(oldId, newId);

    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE evidence_memory_id = ?').get(otherId)).toEqual({ n: 1 });
  });
});

describe('erase_memory cascade (AC-5)', () => {
  let db: DB;
  let entityRepo: EntityRepo;
  let relationRepo: EntityRelationRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    entityRepo = new EntityRepo(db);
    relationRepo = new EntityRelationRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('erase() hard-deletes the memory; citing entity_relations rows are removed via ON DELETE CASCADE with no FK-violation error', () => {
    const memId = makeMemory(db, 'm-erase');
    const subjId = entityRepo.upsert('alice3', 'actor');
    const objId = entityRepo.upsert('bob3', 'actor');
    relationRepo.insert({
      subjectEntityId: subjId, predicate: 'owned_by', objectEntityId: objId,
      evidenceMemoryId: memId, sourceExcerpt: 'excerpt', validFrom: Date.now() - 10_000,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE evidence_memory_id = ?').get(memId)).toEqual({ n: 1 });

    expect(() => events.erase(memId)).not.toThrow();

    expect(db.prepare('SELECT COUNT(*) AS n FROM entity_relations WHERE evidence_memory_id = ?').get(memId)).toEqual({ n: 0 });

    const orphans = db.prepare(`
      SELECT COUNT(*) AS n FROM entity_relations er
      LEFT JOIN memories m ON m.id = er.evidence_memory_id
      WHERE m.id IS NULL
    `).get() as { n: number };
    expect(orphans.n).toBe(0);
  });
});
