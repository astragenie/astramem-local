import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig, type Config } from '../../src/config/config.js';
import { runArchivalPass } from '../../src/storage/archival.js';
import { MemoryEventRepo, MemoryConflictError, MemoryNotFoundError } from '../../src/storage/memory-events.js';
import { recordRecallServed, recordRecallUsed } from '../../src/storage/usefulness.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const SEARCH_WEIGHTS = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const }),
  };
}

/** Raw insert with a caller-controlled created_at, so age-threshold tests
 *  don't have to wait on the clock. Mirrors the pattern already used by
 *  tests/storage/memory-events.test.ts / atom-v3.test.ts. */
function insertMemory(db: DB, id: string, createdAt: number, text = `text-${id}`): void {
  db.prepare(`
    INSERT INTO memories
      (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at,
       valid_from, scope)
    VALUES (?, 'fact', ?, ?, 0.5, 0.5, ?, ?, ?, ?, 'private')
  `).run(id, text, text, `hash-${id}`, createdAt, createdAt, createdAt);
}

function getMemoryRow(db: DB, id: string): { valid_to: number | null; archived: number; archived_at: number | null } {
  return db.prepare('SELECT valid_to, archived, archived_at FROM memories WHERE id = ?').get(id) as
    { valid_to: number | null; archived: number; archived_at: number | null };
}

function enabledConfig(overrides: Partial<Config['archival']> = {}): Config {
  const base = defaultConfig();
  return { ...base, archival: { ...base.archival, enabled: true, ageThresholdDays: 183, usefulnessFloor: 0, ...overrides } };
}

describe('FEAT-404 archival — config defaults (AC-6)', () => {
  it('archival policy has concrete non-null defaults, disabled by default', () => {
    const cfg = defaultConfig();
    expect(cfg.archival).toEqual({ enabled: false, ageThresholdDays: 183, usefulnessFloor: 0 });
  });
});

describe('FEAT-404 archival — runArchivalPass', () => {
  let db: DB;
  const now = Date.now();
  const OLD = now - 200 * DAY_MS; // older than the 183-day default threshold
  const RECENT = now - 5 * DAY_MS; // well under the threshold

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('AC-1: archival.enabled=false archives nothing, even with old + unused memories present', () => {
    insertMemory(db, 'old-unused', OLD);
    const before = db.prepare('SELECT id, valid_to, archived FROM memories').all();

    const result = runArchivalPass(db, defaultConfig(), now);

    expect(result).toEqual({ archived: 0, candidates: 0 });
    const after = db.prepare('SELECT id, valid_to, archived FROM memories').all();
    expect(after).toEqual(before);
    expect(getMemoryRow(db, 'old-unused')).toEqual({ valid_to: null, archived: 0, archived_at: null });
  });

  it('AC-2: old + usefulness at/below the floor gets archived (valid_to + archived flag)', () => {
    insertMemory(db, 'old-unused', OLD);

    const result = runArchivalPass(db, enabledConfig(), now);

    expect(result).toEqual({ archived: 1, candidates: 1 });
    const row = getMemoryRow(db, 'old-unused');
    expect(row.archived).toBe(1);
    expect(row.valid_to).not.toBeNull();
    expect(row.archived_at).not.toBeNull();
  });

  it('AC-2: an archived memory is excluded from search (FTS/vec candidate sets)', async () => {
    insertMemory(db, 'old-unused', OLD, 'a uniquely findable archival phrase');
    runArchivalPass(db, enabledConfig(), now);

    const hits = await search('uniquely findable archival phrase', {}, 10, {
      db,
      embed: buildMockEmbed(),
      weights: SEARCH_WEIGHTS,
    });
    expect(hits.map(h => h.id)).not.toContain('old-unused');
  });

  it('AC-3: old but usefulness at/above the floor is NOT archived — both conditions required', () => {
    insertMemory(db, 'old-but-useful', OLD);
    // recall_served + recall_used within the trailing 7 days -> rate_7d = 1 (> floor 0)
    recordRecallServed(db, { atomIds: ['old-but-useful'], query: 'q', surface: 'rest' });
    recordRecallUsed(db, { atomId: 'old-but-useful', surface: 'rest', signal: 'explicit' });

    const result = runArchivalPass(db, enabledConfig(), now);

    expect(result).toEqual({ archived: 0, candidates: 1 });
    expect(getMemoryRow(db, 'old-but-useful')).toEqual({ valid_to: null, archived: 0, archived_at: null });
  });

  it('not old enough is never a candidate, regardless of usefulness', () => {
    insertMemory(db, 'recent-unused', RECENT);
    const result = runArchivalPass(db, enabledConfig(), now);
    expect(result).toEqual({ archived: 0, candidates: 0 });
  });

  it('AC-5: non-destructive — archiving never changes the memories row count', () => {
    insertMemory(db, 'old-1', OLD);
    insertMemory(db, 'old-2', OLD);
    insertMemory(db, 'recent-1', RECENT);
    const countBefore = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;

    const result = runArchivalPass(db, enabledConfig(), now);
    expect(result.archived).toBe(2);

    const countAfter = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(countAfter).toBe(countBefore);
  });

  it('is idempotent — a second pass finds zero new candidates (already-archived rows are excluded)', () => {
    insertMemory(db, 'old-unused', OLD);
    const cfg = enabledConfig();
    const first = runArchivalPass(db, cfg, now);
    expect(first).toEqual({ archived: 1, candidates: 1 });

    const second = runArchivalPass(db, cfg, now);
    expect(second).toEqual({ archived: 0, candidates: 0 });
  });
});

describe('FEAT-404 archival — MemoryEventRepo.archive/restore', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    insertMemory(db, 'm1', Date.now() - 200 * DAY_MS);
  });

  it('archive() sets valid_to + archived + archived_at and appends an archive event', () => {
    const events = new MemoryEventRepo(db);
    events.archive('m1', 'ttl-policy');

    const row = getMemoryRow(db, 'm1');
    expect(row.archived).toBe(1);
    expect(row.valid_to).not.toBeNull();
    expect(row.archived_at).not.toBeNull();

    const log = events.listForAtom('m1');
    expect(log.some(e => e.event_type === 'archive')).toBe(true);
  });

  it('archive() does NOT append a memory_corrected usefulness signal (routine housekeeping, not a correction)', () => {
    const events = new MemoryEventRepo(db);
    events.archive('m1');
    const log = events.listForAtom('m1');
    expect(log.some(e => e.event_type === 'usefulness')).toBe(false);
  });

  it('archive() throws MemoryConflictError when the memory is already invalid', () => {
    const events = new MemoryEventRepo(db);
    events.invalidate('m1');
    expect(() => events.archive('m1')).toThrow(MemoryConflictError);
  });

  it('archive() throws MemoryNotFoundError for an unknown id', () => {
    const events = new MemoryEventRepo(db);
    expect(() => events.archive('does-not-exist')).toThrow(MemoryNotFoundError);
  });

  it('AC-4: restore() un-archives — memory returns to active candidates and reappears in search', async () => {
    insertMemory(db, 'findable', Date.now() - 200 * DAY_MS, 'a restorable archival phrase');
    const events = new MemoryEventRepo(db);
    events.archive('findable');

    // Confirm it's excluded while archived.
    let hits = await search('restorable archival phrase', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    expect(hits.map(h => h.id)).not.toContain('findable');

    events.restore('findable');

    const row = getMemoryRow(db, 'findable');
    expect(row).toEqual({ valid_to: null, archived: 0, archived_at: null });

    hits = await search('restorable archival phrase', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    expect(hits.map(h => h.id)).toContain('findable');

    const log = events.listForAtom('findable');
    expect(log.some(e => e.event_type === 'restore')).toBe(true);
  });

  it('restore() throws MemoryConflictError when the memory was never archived', () => {
    const events = new MemoryEventRepo(db);
    expect(() => events.restore('m1')).toThrow(MemoryConflictError);
  });

  it('restore() throws MemoryNotFoundError for an unknown id', () => {
    const events = new MemoryEventRepo(db);
    expect(() => events.restore('does-not-exist')).toThrow(MemoryNotFoundError);
  });
});
