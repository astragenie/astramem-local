import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { shimPaths, type ShimPointer } from '../../service/shim.js';
import { releaseIdFromEntryJs, defaultReleasesRoot } from '../../service/release.js';
import { SCHEMA_VERSION } from '../../server/lib/wire-meta.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: Schema drift (FEAT-439 AC-2/AC-5) ────────────────────────────────

interface ServedSchemaVersion {
  version: number;
  source: string;
}

/**
 * Determine the SCHEMA_VERSION of the release actually being served, per
 * current.json's pointer — NOT this doctor process's own import, which only
 * reflects whichever build happens to be running doctor (the repo working
 * tree, when doctor runs from a checkout). When the pointer resolves to a
 * real release dir (release-pinned, not --dev-pinned — same distinction
 * checkServicePointer makes), dynamically imports THAT release's own
 * compiled wire-meta.js so the comparison is against what's genuinely
 * served, not a same-machine coincidence. Falls back to the doctor process's
 * own SCHEMA_VERSION (source: "repo working tree") whenever the pointer is
 * absent, dev-pinned, or its release's wire-meta.js can't be read — matching
 * the FEAT body's third candidate source ("SCHEMA_VERSION of the repo
 * working tree, when doctor runs from repo").
 */
async function resolveServedSchemaVersion(
  pointerPathOverride?: string,
  releasesRootOverride?: string,
): Promise<ServedSchemaVersion> {
  const pointerPath = pointerPathOverride ?? shimPaths().pointerPath;
  if (existsSync(pointerPath)) {
    try {
      const pointer = JSON.parse(readFileSync(pointerPath, 'utf8')) as ShimPointer;
      if (!pointer.devPinned) {
        const id = releaseIdFromEntryJs(pointer.entryJs, releasesRootOverride ?? defaultReleasesRoot());
        if (id) {
          const wireMetaPath = join(dirname(pointer.entryJs), '..', 'server', 'lib', 'wire-meta.js');
          if (existsSync(wireMetaPath)) {
            const mod = (await import(pathToFileURL(wireMetaPath).href)) as { SCHEMA_VERSION?: unknown };
            if (typeof mod.SCHEMA_VERSION === 'number') {
              return { version: mod.SCHEMA_VERSION, source: `release ${id}` };
            }
          }
        }
      }
    } catch {
      // Fall through to the repo-working-tree fallback below — a pointer
      // read/parse/import failure here is not itself a schema-drift finding.
    }
  }
  return { version: SCHEMA_VERSION, source: 'repo working tree' };
}

/**
 * FEAT-439 AC-2/AC-5: compares the served release's SCHEMA_VERSION (see
 * resolveServedSchemaVersion above) against the live DB's migration counter
 * (`MAX(version) FROM schema_version`, the same table migrate.ts's own
 * boot-time drift guard reads — src/storage/migrate.ts:100). Read-only: no
 * writes to the DB, so re-running immediately after a GREEN result stays
 * GREEN with no side effects (AC-5).
 */
export function checkSchemaDrift(
  dataDir: string,
  encryptionEnabled: boolean,
  pointerPathOverride?: string,
  releasesRootOverride?: string,
): Check {
  return {
    name: 'Schema drift',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'schema drift: no DB yet (nothing to compare)' };
      }

      let dbSchemaVersion: number;
      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const tableExists = db
          .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`)
          .get();
        if (!tableExists) {
          return { ok: true, message: 'schema drift: DB not migrated yet (no schema_version table)' };
        }
        const row = db.prepare('SELECT MAX(version) AS max_version FROM schema_version').get() as
          | { max_version: number | null }
          | undefined;
        dbSchemaVersion = row?.max_version ?? 0;
      } catch (err) {
        // The probe itself failed — did NOT verify there's no schema drift.
        return { ok: true, inconclusive: true, message: `schema drift check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }

      const served = await resolveServedSchemaVersion(pointerPathOverride, releasesRootOverride);

      if (served.version === dbSchemaVersion) {
        return {
          ok: true,
          message: `schema drift: none (served ${served.source} SCHEMA_VERSION=${served.version} == DB migration counter=${dbSchemaVersion})`,
        };
      }

      return {
        ok: false,
        message:
          `schema drift: served ${served.source} SCHEMA_VERSION=${served.version} != ` +
          `live DB migration counter=${dbSchemaVersion} — the served build and the live DB have diverged ` +
          `(2026-07-07 stale-dist incident class).`,
        fix: 'astramem-local reinstall',
      };
    },
  };
}
