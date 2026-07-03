import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';

// FEAT-402 (W4.2) AC-2 — migration 012 schema shape, and AC-9 — the
// normalize seam collapsing case/whitespace variants to one entities.id.

describe('migration 012-entities schema (AC-2)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('creates entities and memory_entities tables', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const names = tables.map(t => t.name);
    expect(names).toContain('entities');
    expect(names).toContain('memory_entities');
  });

  it('entities has id, name (UNIQUE), kind', () => {
    const cols = db.prepare('PRAGMA table_info(entities)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('name');
    expect(colNames).toContain('kind');

    db.prepare("INSERT INTO entities (id, name, kind) VALUES ('e1', 'postgres', 'tech')").run();
    expect(() =>
      db.prepare("INSERT INTO entities (id, name, kind) VALUES ('e2', 'postgres', 'tech')").run()
    ).toThrow();
  });

  it('memory_entities has PK(memory_id, entity_id) and an index on entity_id', () => {
    const cols = db.prepare('PRAGMA table_info(memory_entities)').all() as { name: string; pk: number }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('memory_id');
    expect(colNames).toContain('entity_id');
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name).sort();
    expect(pkCols).toEqual(['entity_id', 'memory_id']);

    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='memory_entities'").all() as { name: string; sql: string | null }[];
    expect(indexes.some(i => (i.sql ?? '').includes('entity_id'))).toBe(true);
  });

  it('DB max schema version is 12 after migration', () => {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(12);
  });
});

describe('EntityRepo (AC-9 normalize seam)', () => {
  let db: DB;
  let memRepo: MemoryRepo;
  let entityRepo: EntityRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    memRepo = new MemoryRepo(db);
    entityRepo = new EntityRepo(db);
  });

  function makeMemory(id: string): string {
    return memRepo.insert({
      type: 'fact', text: `about ${id}`, normalized_text: `about ${id}`,
      repo: null, project: null, branch: null, agent: null, session_id: null,
      hash: `hash-${id}`, source_hash: null,
    });
  }

  it('"Postgres" / "postgres" / "  Postgres  " collapse to the same entities.id', () => {
    const id1 = entityRepo.upsert('Postgres', 'tech');
    const id2 = entityRepo.upsert('postgres', 'tech');
    const id3 = entityRepo.upsert('  Postgres  ', 'tech');
    expect(id2).toBe(id1);
    expect(id3).toBe(id1);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('stores the normalized (lowercase, trimmed) name', () => {
    entityRepo.upsert('  Postgres  ', 'tech');
    const row = db.prepare('SELECT name FROM entities').get() as { name: string };
    expect(row.name).toBe('postgres');
  });

  it('linkEntitiesForMemory links a memory to multiple entities, dedup-safe on re-call', () => {
    const memId = makeMemory('m1');
    entityRepo.linkEntitiesForMemory(memId, [
      { name: 'Postgres', kind: 'tech' },
      { name: 'AstraMemory', kind: 'product' },
    ]);
    // Re-calling with an alias-case variant of the same name must not create a duplicate link.
    entityRepo.linkEntitiesForMemory(memId, [{ name: 'postgres', kind: 'tech' }]);

    const linked = entityRepo.listForMemory(memId);
    expect(linked).toHaveLength(2);
    expect(linked.map(e => e.name).sort()).toEqual(['astramemory', 'postgres']);
  });

  it('linkEntitiesForMemory is a no-op for undefined/empty entities', () => {
    const memId = makeMemory('m2');
    entityRepo.linkEntitiesForMemory(memId, undefined);
    entityRepo.linkEntitiesForMemory(memId, []);
    expect(entityRepo.listForMemory(memId)).toEqual([]);
  });

  it('exists() resolves through the normalize seam', () => {
    entityRepo.upsert('TypeScript', 'tech');
    expect(entityRepo.exists('typescript')).toBe(true);
    expect(entityRepo.exists('  TYPESCRIPT  ')).toBe(true);
    expect(entityRepo.exists('rust')).toBe(false);
  });
});
