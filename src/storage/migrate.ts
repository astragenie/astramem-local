import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { SCHEMA_VERSION } from '../server/lib/wire-meta.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Placeholder substituted into migration SQL for the vec schema dim
 * (FEAT-409). Only migrations/001-init.sql uses it today; substitution is
 * a no-op for any migration file that doesn't contain the token. Applying
 * it unconditionally to every not-yet-applied file (rather than special-
 * casing 001) keeps future dim-sensitive migrations trivial to add. */
const EMBED_DIM_PLACEHOLDER = '__EMBED_DIM__';

/**
 * Run pending migrations. `dim` (default DEFAULT_EMBED_DIM = 1024) is
 * baked into any NOT-yet-applied migration file containing the
 * __EMBED_DIM__ placeholder (currently just 001-init's `memories_vec
 * FLOAT[__EMBED_DIM__]`) — i.e. it only matters for a genuinely fresh DB.
 * Already-applied migrations are skipped entirely (schema_version tracks
 * them), so passing a different `dim` against an already-migrated DB is a
 * harmless no-op — the historical FLOAT[N] baked in at creation time is
 * immutable short of the resumable re-embed procedure (migration 011,
 * `astramem-local reembed-dim`, docs/embed-dim-migration.md).
 */
export function migrate(db: DB, dim: number = DEFAULT_EMBED_DIM): void {
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`invalid embedding dim: ${dim} (must be a positive integer)`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_version').all() as {version: number}[])
      .map(r => r.version)
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();

  for (const f of files) {
    const versionStr = f.split('-')[0];
    const version = parseInt(versionStr ?? '', 10);
    if (Number.isNaN(version)) throw new Error(`bad migration name: ${f}`);
    if (applied.has(version)) continue;
    const rawSql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
    const sql = rawSql.split(EMBED_DIM_PLACEHOLDER).join(String(dim));
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(version, Date.now());
    });
    tx();
  }

  // Boot-time schema-version drift guard: the SCHEMA_VERSION constant in
  // wire-meta.ts MUST match the highest migration applied to the DB.
  // If they diverge a migration was added without bumping the constant (or
  // vice-versa). Fail loudly rather than silently serve wrong metadata.
  const dbMaxRow = db
    .prepare('SELECT MAX(version) AS max_version FROM schema_version')
    .get() as { max_version: number | null };
  const dbMax = dbMaxRow.max_version ?? 0;
  if (dbMax !== SCHEMA_VERSION) {
    throw new Error(
      `Schema-version constant drift: wire-meta says ${SCHEMA_VERSION}, DB says ${dbMax}. ` +
      `Bump wire-meta.SCHEMA_VERSION when adding a migration.`,
    );
  }
}
