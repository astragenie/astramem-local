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
    db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
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

  it('personal -> team is allowed and appends a promote_scope event', () => {
    const id = insertMem('scope-1');
    events.promoteScope(id, 'team');
    expect(repo.get(id)?.scope).toBe('team');
    const log = events.listForAtom(id);
    const promoteEvent = log.find(e => e.event_type === 'promote_scope');
    expect(JSON.parse(promoteEvent?.payload_json ?? '{}')).toEqual({ from: 'personal', to: 'team' });
  });

  it('team -> org is allowed', () => {
    const id = insertMem('scope-2');
    events.promoteScope(id, 'team');
    events.promoteScope(id, 'org');
    expect(repo.get(id)?.scope).toBe('org');
  });

  it('personal -> org (skip a level) is allowed — still upward', () => {
    const id = insertMem('scope-3');
    events.promoteScope(id, 'org');
    expect(repo.get(id)?.scope).toBe('org');
  });

  it('downward promotion (team -> personal) is rejected', () => {
    const id = insertMem('scope-4');
    events.promoteScope(id, 'team');
    expect(() => events.promoteScope(id, 'personal')).toThrow(InvalidScopeTransitionError);
  });

  it('same-scope promotion (personal -> personal) is rejected', () => {
    const id = insertMem('scope-5');
    expect(() => events.promoteScope(id, 'personal')).toThrow(InvalidScopeTransitionError);
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
      hash: 'create-evt-1', source_hash: null,
    }, events);

    expect(result.created).toBe(true);
    const log = events.listForAtom(result.id);
    expect(log).toHaveLength(1);
    expect(log[0]?.event_type).toBe('create');
    expect(log[0]?.content_hash).toBe('create-evt-1');
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
