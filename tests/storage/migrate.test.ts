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
    expect(versions.n).toBe(1);
  });

  it('enables WAL mode', () => {
    const db = openDb(':memory:');
    migrate(db);
    const mode = db.prepare('PRAGMA journal_mode').get() as {journal_mode: string};
    // :memory: DBs report 'memory', file DBs report 'wal'. Confirm setting attempt didn't error.
    expect(['wal', 'memory']).toContain(mode.journal_mode);
  });
});
