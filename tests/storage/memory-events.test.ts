import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import {
  MemoryEventRepo,
  MemoryNotFoundError,
  MemoryConflictError,
  InvalidScopeTransitionError,
} from '../../src/storage/memory-events.js';
import { selectPack } from '../../src/recall/pack.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Apply migration files up to (but not including) `beforeVersion`, in order. */
function migrateUpTo(db: DB, beforeVersion: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);
  const files = readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    const version = parseInt(f.split('-')[0] ?? '', 10);
    if (version >= beforeVersion) continue;
    // Substitute the FEAT-409 embed-dim placeholder (real migrate() does this too).
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8').split('__EMBED_DIM__').join('1024'));
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
  }
}

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

const SEARCH_WEIGHTS = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

describe('migration 007 backfill — synthetic create events', () => {
  it('pre-existing memories get a synthetic create event, hash-stable', () => {
    const db = openDb(':memory:');
    // Apply everything up to (not including) 007, insert a legacy row the
    // way pre-Wave-2b code would (no memory_events table exists yet), then
    // apply 007 for real and assert the backfill INSERT ran.
    migrateUpTo(db, 7);
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at,
         valid_from, scope)
      VALUES ('legacy-evt-1', 'fact', 'legacy row', 'legacy row', 0.5, 0.5, 'legacy-evt-hash', 5000, 5000, 5000, 'personal')
    `).run();

    migrate(db);

    const events = new MemoryEventRepo(db).listForAtom('legacy-evt-1');
    expect(events).toHaveLength(1);
    expect(events[0]?.event_type).toBe('create');
    expect(events[0]?.content_hash).toBe('legacy-evt-hash');
    expect(events[0]?.created_at).toBe(5000);
  });

  it('backfill covers every pre-existing memory, one create event each', () => {
    const db = openDb(':memory:');
    migrateUpTo(db, 7);
    for (const [id, hash] of [['leg-a', 'h-a'], ['leg-b', 'h-b'], ['leg-c', 'h-c']] as const) {
      db.prepare(`
        INSERT INTO memories
          (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at,
           valid_from, scope)
        VALUES (?, 'fact', 't', 't', 0.5, 0.5, ?, 1000, 1000, 1000, 'personal')
      `).run(id, hash);
    }

    migrate(db);

    const count = (db.prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE event_type = 'create'`).get() as { n: number }).n;
    expect(count).toBe(3);
  });
});

describe('MemoryEventRepo.append + listForAtom', () => {
  let db: DB;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    events = new MemoryEventRepo(db);
  });

  it('append + listForAtom round-trips in seq order', () => {
    events.append({ event_type: 'create', atom_id: 'a1', content_hash: 'h1', created_at: 1 });
    events.append({ event_type: 'invalidate', atom_id: 'a1', payload: { reason: 'stale' }, created_at: 2 });
    const log = events.listForAtom('a1');
    expect(log.map(e => e.event_type)).toEqual(['create', 'invalidate']);
    expect(log[0]?.seq).toBeLessThan(log[1]?.seq ?? Infinity);
    expect(JSON.parse(log[1]?.payload_json ?? '{}')).toEqual({ reason: 'stale' });
  });

  it('listForAtom for an unknown atom returns an empty array', () => {
    expect(events.listForAtom('nope')).toEqual([]);
  });
});

describe('MemoryEventRepo.invalidate', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('sets valid_to and appends an invalidate event, atomically', () => {
    const id = repo.insert({
      type: 'fact', text: 'gone soon', normalized_text: 'gone soon',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'inv-1', source_hash: null,
    });

    events.invalidate(id, 'superseded manually');

    const m = repo.get(id);
    expect(m?.valid_to).not.toBeNull();

    const log = events.listForAtom(id);
    const invalidateEvent = log.find(e => e.event_type === 'invalidate');
    expect(invalidateEvent).toBeDefined();
    expect(JSON.parse(invalidateEvent?.payload_json ?? '{}')).toEqual({ reason: 'superseded manually' });
  });

  it('invalidate with no reason stores reason: null', () => {
    const id = repo.insert({
      type: 'fact', text: 'no reason given', normalized_text: 'no reason given',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'inv-noreason', source_hash: null,
    });
    events.invalidate(id);
    const log = events.listForAtom(id);
    expect(JSON.parse(log[0]?.payload_json ?? '{}')).toEqual({ reason: null });
  });

  it('double-invalidate throws MemoryConflictError, clearly', () => {
    const id = repo.insert({
      type: 'fact', text: 'double invalidate', normalized_text: 'double invalidate',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'inv-2', source_hash: null,
    });
    events.invalidate(id);
    expect(() => events.invalidate(id)).toThrow(MemoryConflictError);
    expect(() => events.invalidate(id)).toThrow(/already invalid/);
    // Only one invalidate event was recorded — the failed second call left no partial state.
    expect(events.listForAtom(id).filter(e => e.event_type === 'invalidate')).toHaveLength(1);
  });

  it('invalidating an unknown id throws MemoryNotFoundError', () => {
    expect(() => events.invalidate('does-not-exist')).toThrow(MemoryNotFoundError);
  });

  it('invalidated memory is excluded from selectPack and search', async () => {
    const aliveId = repo.insert({
      type: 'decision', text: 'still valid decision', normalized_text: 'still valid decision',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'inv-pack-alive', source_hash: null, importance: 0.9,
    });
    const deadId = repo.insert({
      type: 'decision', text: 'invalidated decision lifecycle test', normalized_text: 'invalidated decision lifecycle test',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'inv-pack-dead', source_hash: null, importance: 0.9,
    });

    events.invalidate(deadId, 'no longer true');

    const pack = selectPack(db, { repo: 'r1', now: Date.now() });
    const packIds = pack.map(m => m.id);
    expect(packIds).toContain(aliveId);
    expect(packIds).not.toContain(deadId);

    const hits = await search('invalidated decision lifecycle test', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    expect(hits.map(h => h.id)).not.toContain(deadId);
  });
});

describe('MemoryEventRepo.supersede', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  function insertMem(hash: string, text = 'supersede test'): string {
    return repo.insert({
      type: 'fact', text, normalized_text: text,
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash, source_hash: null,
    });
  }

  it('old is invalidated + superseded_by set; new stays valid; event appended on old', () => {
    const oldId = insertMem('sup-old-1');
    const newId = insertMem('sup-new-1');

    events.supersede(oldId, newId);

    const oldMem = repo.get(oldId);
    const newMem = repo.get(newId);
    expect(oldMem?.valid_to).not.toBeNull();
    expect(oldMem?.superseded_by).toBe(newId);
    expect(newMem?.valid_to).toBeNull();

    const oldLog = events.listForAtom(oldId);
    const supersedeEvent = oldLog.find(e => e.event_type === 'supersede');
    expect(supersedeEvent).toBeDefined();
    expect(JSON.parse(supersedeEvent?.payload_json ?? '{}')).toEqual({ superseded_by: newId });
  });

  it('unknown oldId throws MemoryNotFoundError', () => {
    const newId = insertMem('sup-new-2');
    expect(() => events.supersede('nope', newId)).toThrow(MemoryNotFoundError);
  });

  it('unknown newId throws MemoryNotFoundError', () => {
    const oldId = insertMem('sup-old-3');
    expect(() => events.supersede(oldId, 'nope')).toThrow(MemoryNotFoundError);
  });

  it('newId that is already invalid throws MemoryConflictError', () => {
    const oldId = insertMem('sup-old-4');
    const newId = insertMem('sup-new-4');
    events.invalidate(newId);
    expect(() => events.supersede(oldId, newId)).toThrow(MemoryConflictError);
  });

  it('oldId that is already invalid throws MemoryConflictError', () => {
    const oldId = insertMem('sup-old-5');
    const newId = insertMem('sup-new-5');
    events.invalidate(oldId);
    expect(() => events.supersede(oldId, newId)).toThrow(MemoryConflictError);
  });

  // FEAT-402 AC-3 — supersede removes the old memory's memory_entities links
  // (the memories row itself survives for bitemporal history, but its
  // entity links do not — a superseded fact stops counting as current
  // evidence for "everything about entity X").
  it('supersede deletes oldId memory_entities links — zero orphan links remain', async () => {
    const { EntityRepo } = await import('../../src/storage/entities.js');
    const entityRepo = new EntityRepo(db);
    const oldId = insertMem('sup-old-entities');
    const newId = insertMem('sup-new-entities');
    entityRepo.linkEntitiesForMemory(oldId, [{ name: 'Postgres', kind: 'tech' }]);
    expect(entityRepo.listForMemory(oldId)).toHaveLength(1);

    events.supersede(oldId, newId);

    expect(entityRepo.listForMemory(oldId)).toEqual([]);
    const orphans = db.prepare(`
      SELECT COUNT(*) AS n FROM memory_entities me
      LEFT JOIN memories m ON m.id = me.memory_id
      WHERE m.id IS NULL
    `).get() as { n: number };
    expect(orphans.n).toBe(0);
  });

  it('supersede does not touch newId memory_entities links', async () => {
    const { EntityRepo } = await import('../../src/storage/entities.js');
    const entityRepo = new EntityRepo(db);
    const oldId = insertMem('sup-old-entities-2');
    const newId = insertMem('sup-new-entities-2');
    entityRepo.linkEntitiesForMemory(newId, [{ name: 'TypeScript', kind: 'tech' }]);

    events.supersede(oldId, newId);

    expect(entityRepo.listForMemory(newId)).toHaveLength(1);
  });

  // FEAT-442: provenance marker for autonomous-consolidation auto-accept —
  // additive on the SAME 'supersede' event type (design-review amendment:
  // least-invasive shape, no new event_type ripple to shipper/wire schema).
  it('provenance param adds auto_accepted/threshold/similarity to the supersede payload', () => {
    const oldId = insertMem('sup-old-prov-1');
    const newId = insertMem('sup-new-prov-1');

    events.supersede(oldId, newId, { autoAccepted: true, threshold: 0.88, similarity: 0.91 });

    const supersedeEvent = events.listForAtom(oldId).find(e => e.event_type === 'supersede');
    expect(JSON.parse(supersedeEvent?.payload_json ?? '{}')).toEqual({
      superseded_by: newId, auto_accepted: true, threshold: 0.88, similarity: 0.91,
    });
  });
});

describe('MemoryEventRepo.unsupersede', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  function insertMem(hash: string, text = 'unsupersede test'): string {
    return repo.insert({
      type: 'fact', text, normalized_text: text,
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash, source_hash: null,
    });
  }

  it('reopens a superseded atom: valid_to/superseded_by cleared, unsupersede event recorded', () => {
    const oldId = insertMem('unsup-old-1');
    const newId = insertMem('unsup-new-1');
    events.supersede(oldId, newId);
    expect(repo.get(oldId)?.valid_to).not.toBeNull();

    events.unsupersede(oldId, 'bad merge');

    const reopened = repo.get(oldId);
    expect(reopened?.valid_to).toBeNull();
    expect(reopened?.superseded_by).toBeNull();

    const types = events.listForAtom(oldId).map(e => e.event_type);
    expect(types).toEqual(['supersede', 'usefulness', 'unsupersede']);
    const unsupEvent = events.listForAtom(oldId).find(e => e.event_type === 'unsupersede');
    expect(JSON.parse(unsupEvent?.payload_json ?? '{}')).toEqual({
      reversed_superseded_by: newId, reason: 'bad merge',
    });
  });

  it('is un-hiding, not un-merging — the winner is untouched (still valid, lineage intact)', () => {
    const oldId = insertMem('unsup-old-2');
    const newId = insertMem('unsup-new-2');
    events.supersede(oldId, newId);
    // Simulate the lineage bookkeeping mergeAsSupersede performs.
    db.prepare('UPDATE memories SET derived_from = ? WHERE id = ?').run(JSON.stringify([oldId]), newId);

    events.unsupersede(oldId);

    const winner = repo.get(newId);
    expect(winner?.valid_to).toBeNull();
    expect(winner?.derived_from).toEqual([oldId]); // lineage kept — this is un-hiding, not un-merging
    expect(repo.get(oldId)?.valid_to).toBeNull(); // both atoms now current simultaneously
  });

  it('unknown id throws MemoryNotFoundError', () => {
    expect(() => events.unsupersede('nope')).toThrow(MemoryNotFoundError);
  });

  it('never-superseded memory throws MemoryConflictError', () => {
    const id = insertMem('unsup-never-superseded');
    expect(() => events.unsupersede(id)).toThrow(MemoryConflictError);
  });

  it('archived (not superseded) memory throws MemoryConflictError — use restore() instead', () => {
    const id = insertMem('unsup-archived');
    events.archive(id);
    expect(() => events.unsupersede(id)).toThrow(MemoryConflictError);
  });

  it('invalidated (not superseded) memory throws MemoryConflictError', () => {
    const id = insertMem('unsup-invalidated');
    events.invalidate(id);
    expect(() => events.unsupersede(id)).toThrow(MemoryConflictError);
  });

  it('reason is optional', () => {
    const oldId = insertMem('unsup-old-3');
    const newId = insertMem('unsup-new-3');
    events.supersede(oldId, newId);
    expect(() => events.unsupersede(oldId)).not.toThrow();
    const unsupEvent = events.listForAtom(oldId).find(e => e.event_type === 'unsupersede');
    expect(JSON.parse(unsupEvent?.payload_json ?? '{}')).toMatchObject({ reason: null });
  });
});

describe('MemoryEventRepo.promoteScope', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  function insertMem(hash: string): string {
    return repo.insert({
      type: 'fact', text: 'scope test', normalized_text: 'scope test',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash, source_hash: null,
    });
  }

  it('private -> team is allowed and appends a promote_scope event', () => {
    const id = insertMem('scope-1');
    events.promoteScope(id, 'team');
    expect(repo.get(id)?.scope).toBe('team');
    const log = events.listForAtom(id);
    const promoteEvent = log.find(e => e.event_type === 'promote_scope');
    expect(JSON.parse(promoteEvent?.payload_json ?? '{}')).toEqual({ from: 'private', to: 'team' });
  });

  it('team -> org is allowed', () => {
    const id = insertMem('scope-2');
    events.promoteScope(id, 'team');
    events.promoteScope(id, 'org');
    expect(repo.get(id)?.scope).toBe('org');
  });

  it('private -> org (skip a level) is allowed — still upward', () => {
    const id = insertMem('scope-3');
    events.promoteScope(id, 'org');
    expect(repo.get(id)?.scope).toBe('org');
  });

  it('downward promotion (team -> private) is rejected', () => {
    const id = insertMem('scope-4');
    events.promoteScope(id, 'team');
    expect(() => events.promoteScope(id, 'private')).toThrow(InvalidScopeTransitionError);
  });

  it('same-scope promotion (private -> private) is rejected', () => {
    const id = insertMem('scope-5');
    expect(() => events.promoteScope(id, 'private')).toThrow(InvalidScopeTransitionError);
  });

  it('unknown id throws MemoryNotFoundError', () => {
    expect(() => events.promoteScope('nope', 'team')).toThrow(MemoryNotFoundError);
  });
});

describe('insertWithCreateEvent', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
  });

  it('inserts a new memory and appends exactly one create event', () => {
    const result = repo.insertWithCreateEvent({
      type: 'fact', text: 'created via event path', normalized_text: 'created via event path',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'create-evt-1', source_hash: null, scope: 'team', importance: 0.7, confidence: 0.8,
    }, events);

    expect(result.created).toBe(true);
    const log = events.listForAtom(result.id);
    expect(log).toHaveLength(1);
    expect(log[0]?.event_type).toBe('create');
    expect(log[0]?.content_hash).toBe('create-evt-1');
    // create event carries content + materialization metadata so cloud
    // replicas are non-empty/searchable (astramem-local#80 / memory#618)
    expect(JSON.parse(log[0]?.payload_json ?? 'null')).toEqual({
      text: 'created via event path', type: 'fact', scope: 'team',
      importance: 0.7, confidence: 0.8, repo: 'r1',
    });
  });

  it('dedup by hash — no duplicate row, no duplicate create event', () => {
    const first = repo.insertWithCreateEvent({
      type: 'fact', text: 'dup a', normalized_text: 'dup a',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'create-evt-dup', source_hash: null,
    }, events);
    const second = repo.insertWithCreateEvent({
      type: 'fact', text: 'dup b', normalized_text: 'dup b',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'create-evt-dup', source_hash: null,
    }, events);

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(events.listForAtom(first.id)).toHaveLength(1);
  });
});
