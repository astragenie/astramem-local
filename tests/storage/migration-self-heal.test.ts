// FEAT-495 item 1 — migration self-heal: schema_version marking a migration
// applied does not prove its DDL actually landed. selfHealMissingColumns()
// re-derives every ADD COLUMN statement on disk and repairs any column
// that's missing despite schema_version saying otherwise.

import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import {
  extractAddColumnStatements,
  selfHealMissingColumns,
  recordSelfHealActions,
  recentSelfHealActions,
} from '../../src/storage/migration-self-heal.js';

describe('extractAddColumnStatements', () => {
  it('extracts table/column/verbatim statement from a real migration file shape', () => {
    const sql = `
-- some comment
ALTER TABLE memories ADD COLUMN evidence TEXT;
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal';
CREATE TABLE unrelated (id TEXT);
`;
    const stmts = extractAddColumnStatements(sql, '004-provenance.sql');
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toMatchObject({ table: 'memories', column: 'evidence', migrationFile: '004-provenance.sql' });
    expect(stmts[0]!.statement).toBe('ALTER TABLE memories ADD COLUMN evidence TEXT;');
    expect(stmts[1]).toMatchObject({ table: 'memories', column: 'scope' });
  });

  it('returns empty for a file with no ADD COLUMN statements', () => {
    expect(extractAddColumnStatements('CREATE TABLE x (id TEXT);', '001-init.sql')).toEqual([]);
  });
});

describe('selfHealMissingColumns', () => {
  let db: DB;

  it('is a no-op on a freshly migrated, healthy database', () => {
    db = openDb(':memory:');
    migrate(db); // migrate() already runs self-heal internally — verify it settles to zero actions
    const actions = selfHealMissingColumns(db);
    expect(actions).toEqual([]);
  });

  it('re-adds a column that a real migration statement expects but is missing from the live table', () => {
    db = openDb(':memory:');
    migrate(db);

    // Simulate a partially-applied migration: drop a real, migration-shipped
    // column from an otherwise fully-migrated DB (schema_version still says
    // every migration ran — exactly the "bookkeeping says applied, DDL
    // didn't land" scenario this feature exists for).
    db.exec('ALTER TABLE memories DROP COLUMN evidence');
    expect((db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some(c => c.name === 'evidence')).toBe(false);

    const actions = selfHealMissingColumns(db);
    expect(actions.some(a => a.table === 'memories' && a.column === 'evidence')).toBe(true);
    expect((db.prepare('PRAGMA table_info(memories)').all() as { name: string }[]).some(c => c.name === 'evidence')).toBe(true);
  });

  it('skips a table that no longer exists (dropped by a later migration) without throwing', () => {
    db = openDb(':memory:');
    migrate(db);
    expect(() => selfHealMissingColumns(db)).not.toThrow();
  });
});

describe('recordSelfHealActions / recentSelfHealActions', () => {
  let db: DB;

  it('records nothing for an empty action list', () => {
    db = openDb(':memory:');
    migrate(db);
    recordSelfHealActions(db, []);
    expect(recentSelfHealActions(db)).toEqual([]);
  });

  it('records and reads back healed-column rows, most recent first', () => {
    db = openDb(':memory:');
    migrate(db);
    recordSelfHealActions(db, [{ migrationFile: '004-provenance.sql', table: 'memories', column: 'evidence' }], 1000);
    recordSelfHealActions(db, [{ migrationFile: '013-archival.sql', table: 'memories', column: 'archived' }], 2000);

    const recent = recentSelfHealActions(db, 10);
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ table: 'memories', column: 'archived', healedAt: 2000 });
    expect(recent[1]).toMatchObject({ table: 'memories', column: 'evidence', healedAt: 1000 });
  });
});

describe('migrate() end-to-end self-heal wiring', () => {
  it('a fresh in-memory DB migrates clean with zero self-heal log rows', () => {
    const db = openDb(':memory:');
    migrate(db);
    expect(recentSelfHealActions(db)).toEqual([]);
  });
});
