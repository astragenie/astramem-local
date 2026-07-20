// Retrieval-overhaul Phase 6 (P6b), migration 056 — memory_links schema
// shape + MemoryLinkRepo's dedup guard + canonical ordering + cascade.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryLinkRepo } from '../../src/storage/memory-links.js';

function makeMemory(db: DB, id: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text: `about ${id}`, normalized_text: `about ${id}`,
    repo: null, project: null, branch: null, agent: null, session_id: null,
    hash: `hash-${id}`, source_hash: null,
  });
}

describe('migration 056-memory-links', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('creates the memory_links table', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('memory_links');
  });

  it('has the expected column shape', () => {
    const cols = db.prepare('PRAGMA table_info(memory_links)').all() as
      Array<{ name: string; notnull: number; pk: number }>;
    const byName = Object.fromEntries(cols.map(c => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(
      ['id', 'memory_id_a', 'memory_id_b', 'link_type', 'evidence', 'confidence', 'created_at'].sort(),
    );
    expect(byName.id!.pk).toBeGreaterThan(0);
    expect(byName.memory_id_a!.notnull).toBe(1);
    expect(byName.memory_id_b!.notnull).toBe(1);
    expect(byName.link_type!.notnull).toBe(1);
    expect(byName.evidence!.notnull).toBe(1);
    expect(byName.confidence!.notnull).toBe(1);
    expect(byName.created_at!.notnull).toBe(1);
  });

  it('rejects an out-of-enum link_type', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    expect(() =>
      db.prepare(`
        INSERT INTO memory_links (id, memory_id_a, memory_id_b, link_type, evidence, confidence, created_at)
        VALUES ('x', ?, ?, 'not_a_real_type', 'evidence', 0.5, 1000)
      `).run(a, b),
    ).toThrow();
  });
});

describe('MemoryLinkRepo', () => {
  let db: DB;
  let repo: MemoryLinkRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryLinkRepo(db);
  });

  it('inserts a link and reports inserted:true', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    const result = repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'shared_entity', evidence: 'alice' });
    expect(result.inserted).toBe(true);
  });

  it('canonicalizes (memoryIdA, memoryIdB) order regardless of call order', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    repo.insert({ memoryIdA: b, memoryIdB: a, linkType: 'shared_entity', evidence: 'alice' });
    const row = db.prepare('SELECT memory_id_a, memory_id_b FROM memory_links').get() as
      { memory_id_a: string; memory_id_b: string };
    const [expectedA, expectedB] = a < b ? [a, b] : [b, a];
    expect(row.memory_id_a).toBe(expectedA);
    expect(row.memory_id_b).toBe(expectedB);
  });

  it('dedup guard: the SAME (a, b, link_type) triple is not inserted twice', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    const first = repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'shared_entity', evidence: 'alice' });
    const second = repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'shared_entity', evidence: 'alice-again' });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n;
    expect(count).toBe(1);
  });

  it('the SAME pair with a DIFFERENT link_type is a distinct row', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'shared_entity', evidence: 'alice' });
    repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'session_proximity', evidence: 'adjacent in extraction order' });
    const count = (db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it('refuses a self-pair (memoryIdA === memoryIdB)', () => {
    const a = makeMemory(db, 'a');
    const result = repo.insert({ memoryIdA: a, memoryIdB: a, linkType: 'shared_entity', evidence: 'alice' });
    expect(result.inserted).toBe(false);
    const count = (db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n;
    expect(count).toBe(0);
  });

  it('confidence defaults to 0.5 when omitted', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'shared_entity', evidence: 'alice' });
    const row = db.prepare('SELECT confidence FROM memory_links').get() as { confidence: number };
    expect(row.confidence).toBe(0.5);
  });

  it('getForMemory returns links touching the memory in either position', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    const c = makeMemory(db, 'c');
    repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'shared_entity', evidence: 'alice' });
    repo.insert({ memoryIdA: c, memoryIdB: a, linkType: 'session_proximity', evidence: 'adjacent in extraction order' });
    const links = repo.getForMemory(a);
    expect(links).toHaveLength(2);
  });

  it('erasing a memory cascades to delete its links (ON DELETE CASCADE)', () => {
    const a = makeMemory(db, 'a');
    const b = makeMemory(db, 'b');
    repo.insert({ memoryIdA: a, memoryIdB: b, linkType: 'shared_entity', evidence: 'alice' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n).toBe(1);

    db.prepare('DELETE FROM memories WHERE id = ?').run(a);

    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_links').get() as { n: number }).n).toBe(0);
  });
});
