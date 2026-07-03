import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { createSnapshot } from '../../src/backup/snapshot.js';
import { verifySnapshot } from '../../src/backup/verify.js';
import { buildDailyTaskXml } from '../../src/service/task-xml.js';

function seedMemories(db: DB, n: number): void {
  const stmt = db.prepare(`
    INSERT INTO memories (id, type, text, normalized_text, hash, created_at, updated_at)
    VALUES (?, 'fact', ?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < n; i++) {
    const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}-${i}`;
    stmt.run(`mem-${uid}`, `memory number ${i}`, `memory number ${i}`, `hash-${uid}`, Date.now(), Date.now());
  }
}

describe('backup verify (W2.1)', () => {
  let dir: string;
  let db: DB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-bak-'));
    db = openDb(join(dir, 'live.sqlite'));
    migrate(db);
    seedMemories(db, 25);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('verifies a good snapshot: integrity ok + counts match', async () => {
    const snapPath = join(dir, 'snap.sqlite');
    await createSnapshot(db, snapPath);
    const v = verifySnapshot(db, snapPath);
    expect(v.ok).toBe(true);
    expect(v.integrity).toBe('ok');
    expect(v.counts.memories).toEqual({ live: 25, snapshot: 25 });
  });

  it('fails verification on a corrupt snapshot', async () => {
    const snapPath = join(dir, 'snap.sqlite');
    await createSnapshot(db, snapPath);
    // Corrupt every page after page 1 (header intact → file opens, b-tree
    // pages destroyed → integrity_check must fail deterministically).
    const fs = await import('node:fs');
    const buf = fs.readFileSync(snapPath);
    buf.fill(0xff, 4096);
    fs.writeFileSync(snapPath, buf);
    const v = verifySnapshot(db, snapPath);
    expect(v.ok).toBe(false);
    expect(v.error).toBeTruthy();
  });

  it('fails verification when snapshot is not a database at all', () => {
    const junkPath = join(dir, 'junk.sqlite');
    writeFileSync(junkPath, 'not a database');
    const v = verifySnapshot(db, junkPath);
    expect(v.ok).toBe(false);
  });

  it('fails when snapshot has MORE rows than live (wrong-file paranoia)', async () => {
    const snapPath = join(dir, 'snap.sqlite');
    await createSnapshot(db, snapPath);
    // Delete rows from live AFTER the snapshot beyond tolerance
    db.prepare(`DELETE FROM memories WHERE id LIKE 'mem-1%'`).run(); // removes 11 rows
    const v = verifySnapshot(db, snapPath, undefined, 5);
    expect(v.ok).toBe(false);
    expect(v.error).toContain('count mismatch');
  });

  it('tolerates small live-ahead drift (online backup)', async () => {
    const snapPath = join(dir, 'snap.sqlite');
    await createSnapshot(db, snapPath);
    seedMemories(db, 3); // live moved ahead a little
    const v = verifySnapshot(db, snapPath, undefined, 10);
    expect(v.ok).toBe(true);
  });
});

describe('daily task XML (W2.4)', () => {
  it('swaps logon trigger for a daily calendar trigger, keeps hardened settings', () => {
    const xml = buildDailyTaskXml({ command: 'C:\\bin\\astramemd.cmd', userId: 'HOST\\u', startTime: '03:00:00' });
    expect(xml).toContain('<CalendarTrigger>');
    expect(xml).toContain('<StartBoundary>2026-01-01T03:00:00</StartBoundary>');
    expect(xml).toContain('<DaysInterval>1</DaysInterval>');
    expect(xml).not.toContain('<LogonTrigger>');
    // Hardened settings preserved
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
  });
});
