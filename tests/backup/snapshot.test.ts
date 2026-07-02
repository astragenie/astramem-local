/**
 * tests/backup/snapshot.test.ts
 *
 * Verifies createSnapshot() produces a valid SQLite copy that is:
 *   - queryable (schema intact)
 *   - non-zero size
 *   - at the requested path
 *
 * Uses a real in-process better-sqlite3 DB so no mocking is needed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3-multiple-ciphers';
import { createSnapshot } from '../../src/backup/snapshot.js';
import { migrate } from '../../src/storage/migrate.js';
import { openDb } from '../../src/storage/db.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `astra-snap-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const cleanups: string[] = [];

function tmpDir(): string {
  const d = makeTmpDir();
  cleanups.push(d);
  return d;
}

afterEach(() => {
  for (const d of cleanups.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('createSnapshot', () => {
  it('creates a backup file at the requested path', async () => {
    const dir = tmpDir();
    const srcPath = join(dir, 'memory.sqlite');
    const outPath = join(dir, 'backups', 'memory-20260627T030000.sqlite');

    const db = openDb(srcPath);
    migrate(db);
    db.prepare("INSERT INTO schema_version(version, applied_at) VALUES (999, datetime('now'))").run();

    const result = await createSnapshot(db, outPath);
    db.close();

    expect(existsSync(outPath)).toBe(true);
    expect(result.path).toBe(outPath);
    expect(result.size_bytes).toBeGreaterThan(0);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('creates intermediate directories when they do not exist', async () => {
    const dir = tmpDir();
    const srcPath = join(dir, 'memory.sqlite');
    const outPath = join(dir, 'deep', 'nested', 'backup.sqlite');

    const db = openDb(srcPath);
    migrate(db);

    await createSnapshot(db, outPath);
    db.close();

    expect(existsSync(outPath)).toBe(true);
  });

  it('backup file is a valid SQLite database (schema intact)', async () => {
    const dir = tmpDir();
    const srcPath = join(dir, 'memory.sqlite');
    const outPath = join(dir, 'backups', 'snap.sqlite');

    const db = openDb(srcPath);
    migrate(db);
    // Insert a test memory row
    db.prepare(`
      INSERT INTO memories(id, type, text, normalized_text, hash, created_at, updated_at)
      VALUES ('test-id', 'fact', 'snapshot test', 'snapshot test', 'h-snapshot', strftime('%s','now')*1000, strftime('%s','now')*1000)
    `).run();

    await createSnapshot(db, outPath);
    db.close();

    // Open the backup independently — must be a valid SQLite file
    const backup = new Database(outPath, { readonly: true });
    const row = backup.prepare("SELECT text FROM memories WHERE id = 'test-id'").get() as
      | { text: string }
      | undefined;
    backup.close();

    expect(row).toBeDefined();
    expect(row!.text).toBe('snapshot test');
  });

  it('returns correct size_bytes matching the file on disk', async () => {
    const dir = tmpDir();
    const srcPath = join(dir, 'memory.sqlite');
    const outPath = join(dir, 'check-size.sqlite');

    const db = openDb(srcPath);
    migrate(db);

    const result = await createSnapshot(db, outPath);
    db.close();

    const { statSync } = await import('node:fs');
    const stat = statSync(outPath);
    expect(result.size_bytes).toBe(stat.size);
  });

  it('can snapshot a DB that has data in all core tables', async () => {
    const dir = tmpDir();
    const srcPath = join(dir, 'memory.sqlite');
    const outPath = join(dir, 'full-snap.sqlite');

    const db = openDb(srcPath);
    migrate(db);

    // Add rows to several tables
    db.prepare(`INSERT INTO sessions(id, started_at) VALUES ('sess-1', datetime('now'))`).run();
    db.prepare(`INSERT INTO jobs(id, kind, payload_json, state, created_at, updated_at)
                VALUES ('job-1', 'distill', '{}', 'pending', datetime('now'), datetime('now'))`).run();

    await createSnapshot(db, outPath);
    db.close();

    const backup = new Database(outPath, { readonly: true });
    const sessCount = (backup.prepare('SELECT count(*) AS n FROM sessions').get() as { n: number }).n;
    const jobCount = (backup.prepare('SELECT count(*) AS n FROM jobs').get() as { n: number }).n;
    backup.close();

    expect(sessCount).toBe(1);
    expect(jobCount).toBe(1);
  });
});
