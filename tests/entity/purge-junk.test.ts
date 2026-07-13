/**
 * `entity-purge-junk` — deletes junk entity rows written before the write-path
 * guard existed (issue #207).
 *
 * The load-bearing test in this file is "C and R survive the purge". A cleanup
 * command that applies a DIFFERENT rule than the write guard is worse than no
 * cleanup: the guard would happily keep "C" (a real programming language), and
 * a purge with its own copy of the rule could delete it — irreversibly, from
 * the user's production store. That is exactly the bug PR #218 shipped (a flat
 * length floor ate "C" and "R") and #219 fixed. One rule, three callers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { purgeJunkEntities } from '../../src/entity/purge-junk.js';
import { randomUUID } from 'node:crypto';
import type { DB } from '../../src/storage/db.js';

describe('purgeJunkEntities', () => {
  let db: DB;
  let entities: EntityRepo;
  let memories: MemoryRepo;
  let events: MemoryEventRepo;

  function addMemory(text: string): string {
    const { id } = memories.insertWithCreateEvent(
      {
        type: 'fact',
        text,
        normalized_text: text,
        repo: 'r1', project: null, branch: null, agent: 'claude-code', session_id: null,
        hash: randomUUID(), source_hash: null,
      },
      events,
    );
    return id;
  }

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    entities = new EntityRepo(db);
    memories = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  afterEach(() => db.close());

  it('dry run is the DEFAULT — nothing is deleted without an explicit opt-in', () => {
    entities.upsert('a', 'repo');
    const before = (db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n;

    const result = purgeJunkEntities(db); // no opts at all

    expect(result.dryRun).toBe(true);
    expect(result.junk).toHaveLength(1);
    expect(result.deleted).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM entities').get() as { n: number }).n).toBe(before);
  });

  it('THE ONE THAT MATTERS: "C" and "R" survive — the purge uses the guard\'s rule, not its own', () => {
    // Both are real, commonly-referenced programming languages. A flat length
    // floor eats them (PR #218 did exactly that; #219 made the rule kind-aware).
    // If this command ever grows its own copy of the rule and drifts, this test
    // fails — which is the entire point of it existing.
    entities.upsert('C', 'tech');
    entities.upsert('R', 'tech');
    entities.upsert('Go', 'tech');

    const result = purgeJunkEntities(db, { dryRun: false });

    expect(result.junk).toHaveLength(0);
    expect(result.deleted).toBe(0);
    // EntityRepo.upsert normalizes names to lowercase on write, so the stored
    // rows are 'c'/'go'/'r'. That normalization is exactly why the purge must
    // call classifyJunkEntityName rather than eyeball the name: a single
    // lowercase letter looks indistinguishable from the "a"/"b"/"c" junk until
    // you also read its `kind`.
    const names = (db.prepare('SELECT name FROM entities ORDER BY name').all() as Array<{ name: string }>)
      .map(r => r.name);
    expect(names).toEqual(['c', 'go', 'r']);
  });

  it('deletes the junk actually seen in prod: single letters tagged `repo`, bare numbers, bare issue refs', () => {
    entities.upsert('a', 'repo');
    entities.upsert('b', 'repo');
    entities.upsert('42', 'other');
    entities.upsert('#123', 'workitem');
    entities.upsert('astramem-local', 'repo'); // real — must survive

    const result = purgeJunkEntities(db, { dryRun: false });

    expect(result.deleted).toBe(4);
    const names = (db.prepare('SELECT name FROM entities').all() as Array<{ name: string }>).map(r => r.name);
    expect(names).toEqual(['astramem-local']);
    expect(new Set(result.junk.map(j => j.reason))).toEqual(
      new Set(['too_short', 'bare_number', 'bare_issue_ref']),
    );
  });

  it('NEVER deletes a memory — only the entity row and its links', () => {
    const memId = addMemory('the parser is written in C, tracked in repo a');
    const junkId = entities.upsert('a', 'repo');
    const realId = entities.upsert('C', 'tech');
    entities.link(memId, junkId);
    entities.link(memId, realId);

    const result = purgeJunkEntities(db, { dryRun: false });

    expect(result.deleted).toBe(1);
    // The memory is untouched — text, embedding, searchability all intact.
    const mem = db.prepare('SELECT id, text FROM memories WHERE id = ?').get(memId) as
      | { id: string; text: string }
      | undefined;
    expect(mem).toBeDefined();
    expect(mem!.text).toContain('written in C');
    // Its link to the REAL entity survives; only the junk link cascaded away.
    const links = db
      .prepare('SELECT entity_id FROM memory_entities WHERE memory_id = ?')
      .all(memId) as Array<{ entity_id: string }>;
    expect(links.map(l => l.entity_id)).toEqual([realId]);
  });

  it('cascade removes memory_entities links, and the count is reported', () => {
    const m1 = addMemory('one');
    const m2 = addMemory('two');
    const junk = entities.upsert('b', 'repo');
    entities.link(m1, junk);
    entities.link(m2, junk);

    const result = purgeJunkEntities(db, { dryRun: false });

    expect(result.deleted).toBe(1);
    expect(result.linksDeleted).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_entities').get() as { n: number }).n).toBe(0);
  });

  it('reports memories left with ZERO entities — the one user-visible consequence', () => {
    const onlyJunk = addMemory('only junk entities');
    const alsoReal = addMemory('has a real one too');
    const junk = entities.upsert('a', 'repo');
    const real = entities.upsert('astramem-local', 'repo');
    entities.link(onlyJunk, junk);
    entities.link(alsoReal, junk);
    entities.link(alsoReal, real);

    const result = purgeJunkEntities(db); // dry run

    // onlyJunk loses its last link; alsoReal keeps `astramem-local`.
    expect(result.memoriesLeftUnlinked).toBe(1);
  });

  it('a clean store reports nothing and deletes nothing', () => {
    entities.upsert('astramem-local', 'repo');
    entities.upsert('TypeScript', 'tech');

    const result = purgeJunkEntities(db, { dryRun: false });

    expect(result.scanned).toBe(2);
    expect(result.junk).toHaveLength(0);
    expect(result.deleted).toBe(0);
  });
});
