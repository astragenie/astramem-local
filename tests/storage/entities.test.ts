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

  it('memory_entities has a surrogate id PK (FEAT-453 migration 023) and an index on entity_id', () => {
    const cols = db.prepare('PRAGMA table_info(memory_entities)').all() as { name: string; pk: number }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('memory_id');
    expect(colNames).toContain('entity_id');
    expect(colNames).toContain('valid_at');
    expect(colNames).toContain('invalid_at');
    const pkCols = cols.filter(c => c.pk > 0).map(c => c.name);
    expect(pkCols).toEqual(['id']);

    const indexes = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='memory_entities'").all() as { name: string; sql: string | null }[];
    expect(indexes.some(i => (i.sql ?? '').includes('entity_id'))).toBe(true);
  });

  it('DB max schema version is 35 after migration', () => {
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(36);
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

// FEAT-402 slice 2 — query surface primitives (AC-4, AC-5).
describe('EntityRepo query surface (slice 2)', () => {
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

  describe('getById', () => {
    it('returns the entity row for a known id', () => {
      const id = entityRepo.upsert('Postgres', 'tech');
      expect(entityRepo.getById(id)).toEqual({ id, name: 'postgres', kind: 'tech' });
    });

    it('returns undefined for an unknown id', () => {
      expect(entityRepo.getById('does-not-exist')).toBeUndefined();
    });
  });

  describe('search (AC-5 autocomplete)', () => {
    it('substring-matches the normalized name, case/whitespace-insensitive query', () => {
      entityRepo.upsert('PostgreSQL', 'tech');
      entityRepo.upsert('TypeScript', 'tech');
      const results = entityRepo.search('  POST  ');
      expect(results.map(e => e.name)).toEqual(['postgresql']);
    });

    it('empty query returns entities alphabetically up to limit', () => {
      entityRepo.upsert('zeta-lib', 'tech');
      entityRepo.upsert('alpha-lib', 'tech');
      const results = entityRepo.search('', 10);
      expect(results.map(e => e.name)).toEqual(['alpha-lib', 'zeta-lib']);
    });

    it('respects the limit parameter', () => {
      entityRepo.upsert('lib-a', 'tech');
      entityRepo.upsert('lib-b', 'tech');
      entityRepo.upsert('lib-c', 'tech');
      expect(entityRepo.search('lib-', 2)).toHaveLength(2);
    });

    it('unmatched query returns []', () => {
      entityRepo.upsert('postgres', 'tech');
      expect(entityRepo.search('nonexistent-entity')).toEqual([]);
    });

    it('% and _ in the query are treated as literal characters, not LIKE wildcards', () => {
      entityRepo.upsert('postgres', 'tech');
      entityRepo.upsert('typescript', 'tech');
      // '%' unescaped would match everything; it must match nothing here.
      expect(entityRepo.search('post%res')).toEqual([]);
    });
  });

  describe('resolveIds (AC-4/AC-9: exact then LIKE)', () => {
    it('resolves an exact normalized match to exactly that entity id', () => {
      const pgId = entityRepo.upsert('PostgreSQL', 'tech');
      entityRepo.upsert('postgresql-fdw', 'tech'); // would also LIKE-match "postgresql"
      expect(entityRepo.resolveIds('PostgreSQL')).toEqual([pgId]);
      expect(entityRepo.resolveIds('  postgresql  ')).toEqual([pgId]);
    });

    it('falls back to a LIKE substring match when no exact row exists', () => {
      const pgId = entityRepo.upsert('postgresql', 'tech');
      expect(entityRepo.resolveIds('postgres')).toEqual([pgId]);
    });

    it('LIKE fallback can resolve to multiple entity ids', () => {
      const a = entityRepo.upsert('libfoo-core', 'tech');
      const b = entityRepo.upsert('libfoo-cli', 'tech');
      expect(entityRepo.resolveIds('libfoo').sort()).toEqual([a, b].sort());
    });

    it('returns [] for an unresolvable name — never falls back to "everything"', () => {
      entityRepo.upsert('postgres', 'tech');
      expect(entityRepo.resolveIds('nonexistent')).toEqual([]);
    });
  });

  describe('memoryIdsForEntities (AC-4 pre-fusion intersection primitive)', () => {
    it('returns the distinct set of memory ids linked to any of the given entity ids', () => {
      const pgId = entityRepo.upsert('postgres', 'tech');
      const tsId = entityRepo.upsert('typescript', 'tech');
      const m1 = makeMemory('m1');
      const m2 = makeMemory('m2');
      const m3 = makeMemory('m3');
      entityRepo.link(m1, pgId);
      entityRepo.link(m2, pgId);
      entityRepo.link(m2, tsId); // m2 linked to both — must appear once
      entityRepo.link(m3, tsId);

      expect(entityRepo.memoryIdsForEntities([pgId])).toEqual(new Set([m1, m2]));
      expect(entityRepo.memoryIdsForEntities([pgId, tsId])).toEqual(new Set([m1, m2, m3]));
    });

    it('returns an empty set for an empty entityIds list (never "no filter")', () => {
      expect(entityRepo.memoryIdsForEntities([])).toEqual(new Set());
    });
  });
});
