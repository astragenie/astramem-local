/**
 * The migration-renumber brick (2026-07-13, issues #185/#186/#188).
 *
 * WHAT HAPPENED. Two migrations were both numbered `030`. `migrate()` keys a
 * migration's identity on THE NUMBER ALONE (`applied.has(version)`), so whichever
 * applied first won and the other was SILENTLY SKIPPED. The fix (#186) renumbered
 * one of them 030 -> 031 — which is unsafe BY CONSTRUCTION for any database that
 * had already applied it as 030:
 *
 *   - `030-<other>.sql`  -> version 30 already recorded -> SILENTLY SKIPPED, its
 *                           table is never created
 *   - `031-<renamed>.sql`-> not recorded -> runs -> CREATE TABLE ... already exists
 *                           -> throws
 *
 * Production was in exactly that state. The daemon would not boot, and `reinstall`'s
 * health check rolled back to a release that also could not boot.
 *
 * #186 added a "no two migration files share a number" guard, which is correct and
 * necessary — but it CANNOT catch the renumber case, because after a renumber the
 * numbers are once again unique. These tests pin the invariants that can.
 *
 * The STRUCTURAL fix is issue #188: record a content hash alongside the version, so
 * a renumbered/replaced migration is detected and reported precisely instead of
 * surfacing as a `CREATE TABLE ... already exists` wearing a misleading
 * "restore from a backup" message. Until that lands, these guard the drift.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCHEMA_VERSION } from '../../src/server/lib/wire-meta.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

function migrationFiles(): { file: string; version: number }[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .map(file => ({ file, version: parseInt(file.split('-')[0] ?? '', 10) }))
    .sort((a, b) => a.version - b.version);
}

describe('migration numbering invariants (issues #185 / #186 / #188)', () => {
  it('every migration filename starts with a parseable number', () => {
    for (const { file, version } of migrationFiles()) {
      expect(Number.isNaN(version), `bad migration name: ${file}`).toBe(false);
    }
  });

  it('no two migrations share a number — one of them would be SILENTLY SKIPPED (#185)', () => {
    const seen = new Map<number, string>();
    for (const { file, version } of migrationFiles()) {
      const prior = seen.get(version);
      expect(
        prior,
        `migrations ${prior} and ${file} share version ${version}. migrate() keys on the ` +
          `number alone, so ONE OF THEM WILL NEVER RUN — and which one depends on apply order.`,
      ).toBeUndefined();
      seen.set(version, file);
    }
  });

  it('migration numbers are contiguous from 001 — a gap means a migration was deleted or renumbered', () => {
    const versions = migrationFiles().map(m => m.version);
    for (let i = 0; i < versions.length; i++) {
      expect(
        versions[i],
        `migration numbering has a gap at ${i + 1} (got ${versions[i]}). A gap means a file was ` +
          `deleted or renumbered — and RENUMBERING AN ALREADY-APPLIED MIGRATION BRICKS EXISTING ` +
          `DATABASES (see this file's header). Add a new migration instead.`,
      ).toBe(i + 1);
    }
  });

  it('SCHEMA_VERSION equals the highest migration number — drift means a boot-time failure', () => {
    const max = Math.max(...migrationFiles().map(m => m.version));
    expect(
      SCHEMA_VERSION,
      `SCHEMA_VERSION (${SCHEMA_VERSION}) != highest migration (${max}). migrate() asserts these ` +
        `match at BOOT and throws "Schema-version constant drift" — the daemon will not start. ` +
        `Bump wire-meta.SCHEMA_VERSION when adding a migration.`,
    ).toBe(max);
  });

  it('no migration file is empty — an empty file still records its version and can never re-run', () => {
    for (const { file } of migrationFiles()) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8').trim();
      expect(sql.length, `${file} is empty`).toBeGreaterThan(0);
    }
  });
});
