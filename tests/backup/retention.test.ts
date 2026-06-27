/**
 * tests/backup/retention.test.ts
 *
 * Verifies pruneOldBackups() retention logic:
 *   - Keeps newest N, deletes older ones
 *   - Returns correct kept/deleted arrays
 *   - Handles edge cases (no dir, exact count, keep=1)
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pruneOldBackups } from '../../src/backup/retention.js';

// ─── Test helpers ─────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `astra-retention-${randomUUID()}`);
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

/**
 * Create N fake backup files in `dir` with staggered mtimes (oldest first).
 * Returns paths from oldest to newest.
 */
function createFakeBackups(dir: string, count: number): string[] {
  const paths: string[] = [];
  const baseTime = Date.now() - count * 10_000; // 10s apart, oldest first
  for (let i = 0; i < count; i++) {
    const name = `memory-202606${String(i + 1).padStart(2, '0')}T030000.sqlite`;
    const fullPath = join(dir, name);
    writeFileSync(fullPath, `sqlite-fake-content-${i}`, 'utf8');
    // Set mtime so ordering is deterministic
    const mtime = new Date(baseTime + i * 10_000);
    utimesSync(fullPath, mtime, mtime);
    paths.push(fullPath);
  }
  return paths; // [oldest, ..., newest]
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('pruneOldBackups', () => {
  it('keeps newest N and deletes older ones (8 backups, keep=7)', () => {
    const dir = tmpDir();
    const paths = createFakeBackups(dir, 8); // paths[0]=oldest, paths[7]=newest

    const result = pruneOldBackups(dir, 7);

    // 7 kept, 1 deleted
    expect(result.kept).toHaveLength(7);
    expect(result.deleted).toHaveLength(1);

    // The oldest file should be deleted
    expect(existsSync(paths[0])).toBe(false);

    // All newer 7 files should still exist
    for (const p of paths.slice(1)) {
      expect(existsSync(p)).toBe(true);
    }
  });

  it('keeps all when count <= keep', () => {
    const dir = tmpDir();
    createFakeBackups(dir, 3);

    const result = pruneOldBackups(dir, 7);

    expect(result.kept).toHaveLength(3);
    expect(result.deleted).toHaveLength(0);
  });

  it('keeps exactly 1 when keep=1 and many files exist', () => {
    const dir = tmpDir();
    const paths = createFakeBackups(dir, 5);

    const result = pruneOldBackups(dir, 1);

    expect(result.kept).toHaveLength(1);
    expect(result.deleted).toHaveLength(4);

    // Only the newest should survive
    expect(existsSync(paths[4])).toBe(true);
    for (const p of paths.slice(0, 4)) {
      expect(existsSync(p)).toBe(false);
    }
  });

  it('returns empty arrays when directory does not exist', () => {
    const dir = join(tmpdir(), `nonexistent-${randomUUID()}`);

    const result = pruneOldBackups(dir, 7);

    expect(result.kept).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('ignores non-backup files in the directory', () => {
    const dir = tmpDir();
    // Create some noise files that should NOT be touched
    writeFileSync(join(dir, 'README.txt'), 'ignore me');
    writeFileSync(join(dir, 'memory.sqlite'), 'main db — not a backup');
    writeFileSync(join(dir, 'something-else.sqlite'), 'wrong pattern');

    // Create 2 real backups
    createFakeBackups(dir, 2);

    const result = pruneOldBackups(dir, 1);

    // 1 kept, 1 deleted; noise files untouched
    expect(result.kept).toHaveLength(1);
    expect(result.deleted).toHaveLength(1);
    expect(existsSync(join(dir, 'README.txt'))).toBe(true);
    expect(existsSync(join(dir, 'memory.sqlite'))).toBe(true);
    expect(existsSync(join(dir, 'something-else.sqlite'))).toBe(true);
  });

  it('returns empty arrays when directory is empty', () => {
    const dir = tmpDir();

    const result = pruneOldBackups(dir, 7);

    expect(result.kept).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('throws when keep < 1', () => {
    const dir = tmpDir();

    expect(() => pruneOldBackups(dir, 0)).toThrow(/keep must be >= 1/);
    expect(() => pruneOldBackups(dir, -5)).toThrow(/keep must be >= 1/);
  });

  it('correctly deletes multiple old backups (10 files, keep=3)', () => {
    const dir = tmpDir();
    const paths = createFakeBackups(dir, 10);

    const result = pruneOldBackups(dir, 3);

    expect(result.kept).toHaveLength(3);
    expect(result.deleted).toHaveLength(7);

    // Newest 3 survive
    for (const p of paths.slice(7)) {
      expect(existsSync(p)).toBe(true);
    }
    // Oldest 7 are gone
    for (const p of paths.slice(0, 7)) {
      expect(existsSync(p)).toBe(false);
    }
  });
});
