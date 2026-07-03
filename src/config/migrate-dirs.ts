/**
 * migrate-dirs.ts
 *
 * One-shot, idempotent migration for daemon installs upgrading from <=0.2.2.
 *
 * Background: daemon <=0.2.2 used `%APPDATA%\AstraMemory` (config) and
 * `%LOCALAPPDATA%\AstraMemory` (data) on Windows. The plugin has always used
 * `%APPDATA%\Astramem`. This divergence caused a bearer mismatch (401 on every
 * ingest) because each product's `init` wizard writes its own `secrets.env`
 * to its own directory.
 *
 * Fix: daemon now uses `Astramem` as the canonical dir name (matching the
 * plugin). This module renames the legacy dirs to canonical on first boot
 * after the upgrade. It is safe to call on every boot.
 *
 * Windows-only. On macOS/Linux the legacy and canonical paths are identical
 * (no migration needed) and this function returns immediately.
 */

import { existsSync, renameSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { platform } from 'node:os';
import { defaultConfigDir, defaultDataDir, legacyConfigDir, legacyDataDir } from './datadir.js';

export interface MigrationResult {
  configMigrated: boolean;
  dataMigrated: boolean;
  warnings: string[];
}

/**
 * Migrate legacy Windows config/data dirs to canonical names if needed.
 *
 * Rules for each dir pair (legacy → canonical):
 * - canonical exists → no-op (already migrated or user did fresh init)
 * - only legacy exists → rename legacy to canonical (log migration)
 * - both exist → no-op, emit warning (user must reconcile manually)
 * - neither exists → no-op (fresh install, nothing to migrate)
 *
 * IMPORTANT: never overwrites canonical if it already contains data. This
 * preserves any bearer the user wrote via `astramem-local init` after upgrading.
 */
export function migrateLegacyDirsIfPresent(): MigrationResult {
  const result: MigrationResult = {
    configMigrated: false,
    dataMigrated: false,
    warnings: [],
  };

  // Non-Windows: legacy and canonical paths are identical — nothing to do.
  if (platform() !== 'win32') {
    return result;
  }

  const pairs: Array<{
    label: string;
    legacy: string;
    canonical: string;
    migratedKey: keyof Pick<MigrationResult, 'configMigrated' | 'dataMigrated'>;
  }> = [
    {
      label: 'config',
      legacy: legacyConfigDir(),
      canonical: defaultConfigDir(),
      migratedKey: 'configMigrated',
    },
    {
      label: 'data',
      legacy: legacyDataDir(),
      canonical: defaultDataDir(),
      migratedKey: 'dataMigrated',
    },
  ];

  for (const { label, legacy, canonical, migratedKey } of pairs) {
    const legacyExists = existsSync(legacy);
    const canonicalExists = existsSync(canonical);

    if (!legacyExists) {
      // Fresh install or already migrated (canonical may or may not exist). No-op.
      continue;
    }

    if (canonicalExists) {
      // Both exist. Reconcile per-file: copy (never move, never overwrite)
      // any file the canonical dir LACKS that the legacy dir has. This
      // rescues the stranded-data case — e.g. a fresh canonical dir created
      // next to a legacy dir that still holds the real memory.sqlite —
      // while never clobbering a valid canonical bearer or database.
      const candidates =
        label === 'config'
          ? ['secrets.env', 'config.yaml']
          : ['memory.sqlite', 'memory.sqlite-wal', 'memory.sqlite-shm'];
      // Data pair: the DB and its WAL/SHM are one consistency unit — only
      // copy when the canonical dir has NONE of them (a mismatched WAL
      // corrupts the database). Config pair: copy per-file.
      let copyable: string[];
      if (label === 'data') {
        const canonicalHasAny = candidates.some(f => existsSync(join(canonical, f)));
        copyable = canonicalHasAny ? [] : candidates.filter(f => existsSync(join(legacy, f)));
      } else {
        copyable = candidates.filter(f => existsSync(join(legacy, f)) && !existsSync(join(canonical, f)));
      }
      let copied = 0;
      for (const f of copyable) {
        try {
          // tmp + rename so a crash mid-copy never leaves a torn file at the
          // canonical path (same pattern as migrate-encrypt.ts).
          const tmp = join(canonical, `${f}.migrating-tmp`);
          copyFileSync(join(legacy, f), tmp);
          renameSync(tmp, join(canonical, f));
          copied++;
          console.log(`[astramem-local] reconciled ${label} file from legacy dir: ${f}`);
        } catch (err) {
          result.warnings.push(`Failed to copy legacy ${label} file "${f}": ${err}`);
        }
      }
      if (copied > 0) result[migratedKey] = true;

      const bothHaveDb =
        label === 'data' &&
        existsSync(join(legacy, 'memory.sqlite')) &&
        existsSync(join(canonical, 'memory.sqlite'));
      const warning = bothHaveDb
        ? `Two ${label} dirs BOTH contain memory.sqlite: "${legacy}" and "${canonical}". ` +
          `Using canonical — verify it holds your real data (run 'astramem-local doctor'); ` +
          `the legacy copy was left untouched.`
        : `Two ${label} dirs detected: "${legacy}" and "${canonical}". Using canonical` +
          (copied > 0 ? ` (${copied} missing file(s) copied from legacy).` : '.') +
          ` Legacy dir left untouched; delete manually after verifying.`;
      result.warnings.push(warning);
      console.warn(`[astramem-local] WARN: ${warning}`);
      continue;
    }

    // Only legacy exists → rename to canonical.
    try {
      renameSync(legacy, canonical);
      result[migratedKey] = true;
      console.log(
        `[astramem-local] migrated legacy ${label} dir: "${legacy}" → "${canonical}"`,
      );
    } catch (err) {
      const warning =
        `Failed to migrate legacy ${label} dir from "${legacy}" to "${canonical}": ${err}. ` +
        `Manual rename required to restore bearer compatibility with the plugin.`;
      result.warnings.push(warning);
      console.warn(`[astramem-local] WARN: ${warning}`);
    }
  }

  return result;
}
