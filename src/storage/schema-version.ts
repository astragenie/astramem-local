/**
 * Single source of truth for SCHEMA_VERSION: derived from the migrations/
 * directory on disk, not declared as a literal.
 *
 * Before this file existed, the expected schema version was a hardcoded
 * integer in NINE places (wire-meta.ts's SCHEMA_VERSION constant plus
 * toBe(N)/toHaveLength(N) assertions in eight test files) — so any two
 * migration-bearing PRs collided by construction, regardless of what they
 * actually changed. Measured cost: #212 was renumbered twice while merging
 * (it was itself the fix for issue #188 — the bug ate its own fix), and
 * #216 was renumbered four times (033 -> 034 -> 035 -> 036 -> 037), once per
 * PR that landed ahead of it. See docs/specs/20260713-stability-wave-plan.md
 * §B4 for the incident record.
 *
 * This module has ZERO internal imports (only node:fs/path/url) so that
 * both src/storage/migrate.ts and src/server/lib/wire-meta.ts — which
 * otherwise have no dependency relationship — can import from it without
 * creating a cycle. That also makes doctor's cross-release check
 * (resolveServedSchemaVersion in src/doctor/checks.ts, which dynamically
 * `import()`s a DIFFERENT release's own wire-meta.js) resolve correctly:
 * the dynamically-imported wire-meta.js re-exports SCHEMA_VERSION from
 * ITS OWN copy of this file, whose MIGRATIONS_DIR is computed relative to
 * itself — so it reports that release's own on-disk migrations/, not the
 * currently-running process's.
 */
import { readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** migrations/ ships as a sibling of dist/ both in a repo checkout (repo
 *  root) and in a materialized release (release root) — see
 *  materializeRelease's `for (const top of ['dist', 'migrations'])` copy
 *  step and its own hard assertion that migrations/ must exist alongside
 *  dist/ (src/service/release.ts). Two levels up from this compiled
 *  file's own directory (dist/storage -> dist -> release/repo root)
 *  reaches it — the same depth src/storage/migrate.ts has always used. */
export const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

const MIGRATION_FILENAME_RE = /^(\d+)-.+\.sql$/;

/**
 * The current schema version: the highest `NNN-` prefix among migration
 * files in `dir`. Adding a migration file is the only thing that bumps it.
 *
 * Throws rather than returning 0/undefined for an empty or unparseable
 * directory — a schema version of "nothing" must never look like a valid
 * boot (ADR-015: success and silent failure must never be the same
 * observable state).
 */
export function deriveSchemaVersion(dir: string = MIGRATIONS_DIR): number {
  const versions = readdirSync(dir)
    .filter(f => f.endsWith('.sql'))
    .map(f => MIGRATION_FILENAME_RE.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(v => parseInt(v, 10));

  if (versions.length === 0) {
    throw new Error(
      `deriveSchemaVersion: no parseable NNN-*.sql migration files found in ${dir} -- cannot determine SCHEMA_VERSION.`,
    );
  }
  return Math.max(...versions);
}

/** Computed once at module load, from the real migrations/ directory next
 *  to wherever this compiled module physically lives. */
export const SCHEMA_VERSION: number = deriveSchemaVersion();
