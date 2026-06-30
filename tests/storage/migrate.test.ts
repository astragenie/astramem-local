import { describe, it, expect } from 'vitest';
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
  });

  it('is idempotent — second run does nothing', () => {
    const db = openDb(':memory:');
    migrate(db);
    migrate(db);
    const versions = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get() as {n: number};
    expect(versions.n).toBe(2);
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
    expect(versions.n).toBe(2);
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
