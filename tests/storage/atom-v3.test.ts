import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
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

describe('Atom v3 migration (006-atom-v3, ADR-001)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  it('applies cleanly on a fresh DB and adds the new columns', () => {
    expect(() => migrate(db)).not.toThrow();
    const cols = db.prepare('PRAGMA table_info(memories)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('valid_from');
    expect(colNames).toContain('valid_to');
    expect(colNames).toContain('superseded_by');
    expect(colNames).toContain('derived_from');
    expect(colNames).toContain('scope');
  });

  it('DB max schema version is 6 after migration', () => {
    migrate(db);
    const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(row.v).toBe(6);
  });

  it('a new row inserted via the repo gets valid_from = created_at, scope personal, valid_to null', () => {
    migrate(db);
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'fact',
      text: 'atom v3 backfill check',
      normalized_text: 'atom v3 backfill check',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'atom-v3-h1', source_hash: null,
    });
    const m = repo.get(id);
    expect(m).not.toBeNull();
    expect(m?.valid_from).toBe(m?.created_at);
    expect(m?.valid_to).toBeNull();
    expect(m?.scope).toBe('personal');
    expect(m?.superseded_by).toBeNull();
    expect(m?.derived_from).toBeNull();
  });

  it('honors an explicit non-default scope on insert', () => {
    migrate(db);
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'team-scoped fact', normalized_text: 'team-scoped fact',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'atom-v3-h-scope', source_hash: null, scope: 'team',
    });
    expect(repo.get(id)?.scope).toBe('team');
  });

  it('backfills valid_from = created_at for rows that predate the migration', () => {
    // Apply 001-005 only (pre-Atom-v3 schema — no valid_from/scope columns
    // exist yet), insert a legacy row the way v0.x code would, then apply
    // 006 for real and assert the backfill UPDATE ran.
    migrateUpTo(db, 6);
    db.prepare(`
      INSERT INTO memories
        (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
      VALUES ('legacy-1', 'fact', 'legacy row', 'legacy row', 0.5, 0.5, 'legacy-hash', 12345, 12345)
    `).run();

    // Now bring the DB the rest of the way up via the real migrate(), which
    // applies 006-atom-v3.sql (ADD COLUMN + backfill UPDATE).
    migrate(db);

    const row = db.prepare('SELECT valid_from, created_at, valid_to, scope FROM memories WHERE id = ?')
      .get('legacy-1') as { valid_from: number; created_at: number; valid_to: number | null; scope: string };
    expect(row.valid_from).toBe(row.created_at);
    expect(row.valid_to).toBeNull();
    expect(row.scope).toBe('personal');
  });

  it('derived_from round-trips through repo.get as a string array', () => {
    migrate(db);
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'consolidated fact', normalized_text: 'consolidated fact',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'atom-v3-derived-1', source_hash: null,
    });
    // derived_from is not exposed on InsertInput (consolidation lineage is
    // written by the stage-9 consolidation pass, not initial insert) — set
    // it directly at the storage boundary and verify repo.get() hydrates the
    // stored JSON string back into a string[].
    db.prepare('UPDATE memories SET derived_from = ? WHERE id = ?')
      .run(JSON.stringify(['src-a', 'src-b']), id);
    const m = repo.get(id);
    expect(m?.derived_from).toEqual(['src-a', 'src-b']);
  });

  it('a row with no derived_from hydrates to null, not an empty array', () => {
    migrate(db);
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'no lineage', normalized_text: 'no lineage',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'atom-v3-derived-null', source_hash: null,
    });
    expect(repo.get(id)?.derived_from).toBeNull();
  });
});

describe('Atom v3 — recall exclusion of invalidated memories', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('selectPack excludes a memory whose valid_to is set', () => {
    const aliveId = repo.insert({
      type: 'decision', text: 'still valid decision', normalized_text: 'still valid decision',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'pack-alive', source_hash: null, importance: 0.9,
    });
    const deadId = repo.insert({
      type: 'decision', text: 'superseded decision', normalized_text: 'superseded decision',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'pack-dead', source_hash: null, importance: 0.9,
    });
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(Date.now(), deadId);

    const pack = selectPack(db, { repo: 'r1', now: Date.now() });
    const ids = pack.map(m => m.id);
    expect(ids).toContain(aliveId);
    expect(ids).not.toContain(deadId);
  });

  it('search excludes a memory whose valid_to is set but still resolves via repo.get (why_memory path)', async () => {
    const aliveId = repo.insert({
      type: 'fact', text: 'atom v3 search visibility check alive', normalized_text: 'atom v3 search visibility check alive',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'search-alive', source_hash: null,
    });
    const deadId = repo.insert({
      type: 'fact', text: 'atom v3 search visibility check dead', normalized_text: 'atom v3 search visibility check dead',
      repo: 'r1', project: null, branch: null, agent: null, session_id: null,
      hash: 'search-dead', source_hash: null,
    });
    db.prepare('UPDATE memories SET valid_to = ? WHERE id = ?').run(Date.now(), deadId);

    const hits = await search('atom v3 search visibility check', {}, 10, {
      db, embed: buildMockEmbed(), weights: SEARCH_WEIGHTS,
    });
    const ids = hits.map(h => h.id);
    expect(ids).toContain(aliveId);
    expect(ids).not.toContain(deadId);

    // why_memory-style lookup by id still works for the invalidated memory —
    // receipts for dead memories still matter.
    const deadReceipt = repo.get(deadId);
    expect(deadReceipt).not.toBeNull();
    expect(deadReceipt?.text).toBe('atom v3 search visibility check dead');
    expect(deadReceipt?.valid_to).not.toBeNull();
  });
});
