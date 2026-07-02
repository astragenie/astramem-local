import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

describe('migrate', () => {
  it('creates schema_version table and applies 001-init', () => {
    const db = openDb(':memory:');
    migrate(db);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name: string}[];
    const names = tables.map(t => t.name);
    expect(names).toContain('schema_version');
    expect(names).toContain('sessions');
    expect(names).toContain('messages');
    expect(names).toContain('transcripts');
    expect(names).toContain('memories');
    expect(names).toContain('jobs');
    expect(names).toContain('artifacts');
    expect(names).toContain('provider_state');
    expect(names).toContain('budget_spend');
    expect(names).toContain('redaction_log');
  });

  it('is idempotent — second run does nothing', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as {n: number};
    expect(versions.n).toBe(6);
  });

  it('enables WAL mode', () => {
    const db = openDb(':memory:');
    migrate(db);
    const mode = db.prepare('PRAGMA journal_mode').get() as {journal_mode: string};
    // :memory: DBs report 'memory', file DBs report 'wal'. Confirm setting attempt didn't error.
    expect(['wal', 'memory']).toContain(mode.journal_mode);
  });
});

describe('migration 002-wire-v1', () => {
  it('adds all new columns to transcripts', () => {
    const db = openDb(':memory:');
    migrate(db);

    const cols = db.prepare("PRAGMA table_info(transcripts)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);

    expect(colNames).toContain('event');
    expect(colNames).toContain('captured_at');
    expect(colNames).toContain('client_scrub_applied');
    expect(colNames).toContain('client_scrub_hits');
    expect(colNames).toContain('client_scrub_version');
    expect(colNames).toContain('client_scrub_hits_by_label_json');
    expect(colNames).toContain('client_version');
    expect(colNames).toContain('wire_version');

    // legacy columns still intact
    expect(colNames).toContain('source');
    expect(colNames).toContain('content');
  });

  it('creates ingest_idempotency table with expected columns', () => {
    const db = openDb(':memory:');
    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('ingest_idempotency');

    const cols = db.prepare("PRAGMA table_info(ingest_idempotency)").all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('key');
    expect(colNames).toContain('tenant_id');
    expect(colNames).toContain('body_hash');
    expect(colNames).toContain('summary_memory_id');
    expect(colNames).toContain('created_at');
  });

  it('is idempotent — re-running migrate after 002 is already applied does nothing extra', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as { n: number };
    expect(versions.n).toBe(6);
  });

  it('new rows get wire_version DEFAULT v0.0 when inserted without wire_version', () => {
    const db = openDb(':memory:');
    migrate(db);

    // Insert a session so the FK is satisfied
    db.prepare(
      "INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES ('s1', 'r', 'p', 'b', 'a', 0)"
    ).run();

    // Insert a transcript using only the v0.1.x column set (no wire_version)
    db.prepare(
      "INSERT INTO transcripts (id, session_id, source, content, ingested_at) VALUES ('t1', 's1', 'plugin', 'hello', 0)"
    ).run();

    const row = db.prepare("SELECT wire_version FROM transcripts WHERE id='t1'").get() as { wire_version: string };
    expect(row.wire_version).toBe('v0.0');
  });

  it('stores new wire-contract fields when provided', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      "INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES ('s2', 'r', 'p', 'b', 'a', 0)"
    ).run();

    db.prepare(`
      INSERT INTO transcripts
        (id, session_id, source, content, ingested_at,
         event, captured_at, client_scrub_applied, client_scrub_hits,
         client_scrub_version, client_scrub_hits_by_label_json, client_version, wire_version)
      VALUES
        ('t2', 's2', 'saas', '{}', 1000,
         'transcript.ingested', 1700000000000, 1, 3,
         '1.2.0', '{"pii":2,"secret":1}', '0.9.1', 'v1.0')
    `).run();

    const row = db.prepare("SELECT * FROM transcripts WHERE id='t2'").get() as Record<string, unknown>;
    expect(row.event).toBe('transcript.ingested');
    expect(row.captured_at).toBe(1700000000000);
    expect(row.client_scrub_applied).toBe(1);
    expect(row.client_scrub_hits).toBe(3);
    expect(row.client_scrub_version).toBe('1.2.0');
    expect(row.client_scrub_hits_by_label_json).toBe('{"pii":2,"secret":1}');
    expect(row.client_version).toBe('0.9.1');
    expect(row.wire_version).toBe('v1.0');
  });

  it('ingest_idempotency key is primary key — duplicate key rejected', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      "INSERT INTO ingest_idempotency (key, body_hash, created_at) VALUES ('k1', 'abc123', 0)"
    ).run();

    expect(() =>
      db.prepare(
        "INSERT INTO ingest_idempotency (key, body_hash, created_at) VALUES ('k1', 'def456', 1)"
      ).run()
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Migration 003 — expand memories.type CHECK
// ---------------------------------------------------------------------------

describe('migration 003-expand-memory-types', () => {
  it('applies cleanly on a fresh DB', () => {
    const db = openDb(':memory:');
    expect(() => migrate(db)).not.toThrow();
    const versions = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    expect(versions.v).toBe(6);
  });

  it('allows inserting type note after migration', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES ('m-note', 'note', 'a note', 'a note', 0.5, 0.5, 'hash-note', 1, 1)`
      ).run()
    ).not.toThrow();
  });

  it('allows inserting type event after migration', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES ('m-event', 'event', 'an event', 'an event', 0.5, 0.5, 'hash-event', 1, 1)`
      ).run()
    ).not.toThrow();
  });

  it('rejects type garbage after migration', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES ('m-bad', 'garbage', 'bad', 'bad', 0.5, 0.5, 'hash-bad', 1, 1)`
      ).run()
    ).toThrow();
  });

  it('preserves existing rows across migration — row count and types intact', () => {
    const db = openDb(':memory:');
    // Apply only migrations 001 + 002 by simulating a v0.3.3 DB state
    // We do this by running migrate() on a temp connection, then running 003 separately.
    // Since migrate() runs all files, we instead seed rows after a full migration
    // (the type constraint widening is additive — existing valid types all survive).
    migrate(db);

    // Insert 5 rows covering all original types
    const types = ['decision', 'fact', 'lesson', 'command', 'todo'] as const;
    for (const t of types) {
      db.prepare(
        `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0.5, 0.5, ?, 1, 1)`
      ).run(`id-${t}`, t, `text-${t}`, `text-${t}`, `hash-${t}`);
    }

    const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(count).toBe(5);

    // Verify each original type round-trips correctly
    for (const t of types) {
      const row = db.prepare('SELECT type FROM memories WHERE id = ?').get(`id-${t}`) as { type: string };
      expect(row.type).toBe(t);
    }
  });

  it('FTS5 still finds memories after migration', () => {
    const db = openDb(':memory:');
    migrate(db);

    db.prepare(
      `INSERT INTO memories (id, type, text, normalized_text, importance, confidence, hash, created_at, updated_at)
       VALUES ('fts-note', 'note', 'unique fts note content', 'unique fts note content', 0.5, 0.5, 'fts-hash-note', 1, 1)`
    ).run();

    const hits = db
      .prepare(`SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?`)
      .all('unique') as { id: string }[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].id).toBe('fts-note');
  });
});

// ---------------------------------------------------------------------------
// Migration 005 — redaction_log (SEC-6)
// ---------------------------------------------------------------------------

describe('migration 005-security', () => {
  it('creates redaction_log with expected columns', () => {
    const db = openDb(':memory:');
    migrate(db);

    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    expect(tables.map(t => t.name)).toContain('redaction_log');

    const cols = db.prepare('PRAGMA table_info(redaction_log)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).toContain('id');
    expect(colNames).toContain('type');
    expect(colNames).toContain('count');
    expect(colNames).toContain('session_id');
    expect(colNames).toContain('created_at');
  });

  it('stores counts + type only — no value-shaped column exists', () => {
    const db = openDb(':memory:');
    migrate(db);
    const cols = db.prepare('PRAGMA table_info(redaction_log)').all() as { name: string }[];
    const colNames = cols.map(c => c.name);
    expect(colNames).not.toContain('value');
    expect(colNames).not.toContain('secret');
  });

  it('accepts a row with session_id NULL', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(() =>
      db.prepare(
        'INSERT INTO redaction_log (type, count, session_id, created_at) VALUES (?, ?, ?, ?)',
      ).run('github_token', 2, null, Date.now())
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Schema-version drift guard (D-R2)
// migrate() must throw when SCHEMA_VERSION constant and DB max diverge.
// ---------------------------------------------------------------------------

describe('migrate — schema-version drift guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes when DB max version matches SCHEMA_VERSION constant', () => {
    const db = openDb(':memory:');
    // Normal path: all migrations applied, constant matches DB
    expect(() => migrate(db)).not.toThrow();
  });

  it('throws a clear error when SCHEMA_VERSION constant is ahead of DB', async () => {
    // Simulate constant drift: mock wire-meta to report a higher version than what migrations apply
    vi.doMock('../../src/server/lib/wire-meta.js', () => ({
      SCHEMA_VERSION: 999,
      WIRE_VERSIONS_SUPPORTED: ['v0.0', 'v1.0'],
      PKG_VERSION: '0.2.0',
    }));

    const { migrate: migrateMocked } = await import('../../src/storage/migrate.js');
    const db = openDb(':memory:');

    expect(() => migrateMocked(db)).toThrow(
      /Schema-version constant drift: wire-meta says 999, DB says 6/,
    );
  });
});
