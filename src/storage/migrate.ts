import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import { SCHEMA_VERSION } from '../server/lib/wire-meta.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';
import { contentHash } from './content-hash.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

/** Placeholder substituted into migration SQL for the vec schema dim
 * (FEAT-409). Only migrations/001-init.sql uses it today; substitution is
 * a no-op for any migration file that doesn't contain the token. Applying
 * it unconditionally to every not-yet-applied file (rather than special-
 * casing 001) keeps future dim-sensitive migrations trivial to add. */
const EMBED_DIM_PLACEHOLDER = '__EMBED_DIM__';

/** Strip the leading `NNN-` and trailing `.sql` off a migration filename,
 * e.g. `030-evidence-guard-drops.sql` -> `evidence-guard-drops` -- used only
 * to keep the schema-drift diagnostic (issue #188) readable. */
function migrationSlug(filename: string): string {
  return filename.replace(/^\d+-/, '').replace(/\.sql$/, '');
}

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

  // sha256_hex(text) -- custom SQL function backing
  // migrations/015-canonical-content-hash.sql's data-only recompute of
  // legacy 32-char truncated content hashes to the full 64-char digest
  // (astramem-local#84). Delegates to the SAME contentHash() helper the
  // application call sites use post-fix, so the migration and the runtime
  // code can never compute a different digest for the same input. Cheap to
  // register unconditionally on every migrate() call (a no-op for every
  // migration file that doesn't reference it) -- better-sqlite3 allows
  // re-registering a function under the same name on a connection.
  db.function('sha256_hex', (text: unknown) => contentHash(String(text)));

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
    try {
      tx();
    } catch (err) {
      // FEAT-420 AC-3: a half-migrated datadir (e.g. the schema_version row
      // for the last-applied migration was lost while the underlying schema
      // change already landed) makes migrate() try to re-apply SQL against
      // an already-migrated table — SQLite throws a low-level error (e.g.
      // "duplicate column name") that IS fail-loud but not actionable on its
      // own. Wrap it so the operator gets a diagnosis, not just a raw DDL
      // error. No change to migration order/content/skip logic above.
      throw new Error(
        `Migration ${f} (version ${version}) failed to apply — the database schema may already ` +
        `partially reflect this migration while schema_version does not record it (a half-migrated ` +
        `or corrupted datadir). Restore from a backup rather than continuing. Original error: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // --- issue #188: schema_version content-hash verification + backfill -----
  // Migration 033 adds `filename`/`content_hash` columns to schema_version
  // (applied above, through the normal loop, like any other migration — by
  // this point dbMax is guaranteed to equal SCHEMA_VERSION, so the columns
  // are guaranteed to exist). The INSERT in the loop above never populates
  // them (it can't — on a genuinely fresh DB, migrations 001..032 apply
  // *before* 033 adds the columns at all), so every row reaching this point
  // needs exactly one of two things done to it:
  //
  //   - content_hash IS NULL (a pre-#188 row, e.g. the operator's production
  //     DB, OR a row this very call just inserted through the loop above) ->
  //     BACKFILL a baseline hash from whatever file occupies that version
  //     number on disk TODAY. This is NOT a reconstruction of history — the
  //     file may have changed since it was actually applied — it's a
  //     "starting now" baseline (issue #188 AC-3). A version whose file no
  //     longer exists on disk at all is left NULL forever: there is nothing
  //     to hash, and guessing would be worse than not checking.
  //   - content_hash already recorded (backfilled or verified on a PRIOR
  //     boot) -> VERIFY it against today's disk content. A mismatch means
  //     the file occupying this version number today is NOT the file that
  //     was actually applied when this version was recorded — the exact
  //     renumber-collision shape behind #185/#186 — and gets a precise,
  //     actionable diagnosis instead of a raw `CREATE TABLE ... already
  //     exists` wearing a misleading "restore from a backup" costume.
  //
  // Net effect: the FIRST boot after this fix ships only ever backfills (every
  // row is NULL going in) — the operator's existing 15k+-memory production DB
  // boots clean with zero risk of a false mismatch. Verification only starts
  // protecting from the SECOND boot onward, once a real baseline exists.
  const fileByVersion = new Map<number, string>();
  for (const f of files) {
    const version = parseInt(f.split('-')[0] ?? '', 10);
    if (!Number.isNaN(version)) fileByVersion.set(version, f);
  }

  const versionRows = db
    .prepare('SELECT version, filename, content_hash FROM schema_version ORDER BY version')
    .all() as { version: number; filename: string | null; content_hash: string | null }[];

  const backfillStmt = db.prepare(
    'UPDATE schema_version SET filename = ?, content_hash = ? WHERE version = ?',
  );

  const verifyAndBackfill = db.transaction(() => {
    for (const row of versionRows) {
      const diskFile = fileByVersion.get(row.version);
      if (!diskFile) continue; // no file on disk for this version anymore — nothing to check against

      const diskHash = contentHash(readFileSync(join(MIGRATIONS_DIR, diskFile), 'utf8'));

      if (row.content_hash == null) {
        backfillStmt.run(diskFile, diskHash, row.version);
        continue;
      }

      if (row.content_hash !== diskHash) {
        throw new Error(
          `Migration ${row.version} was applied as '${migrationSlug(row.filename ?? '(unknown)')}' ` +
          `(hash ${row.content_hash.slice(0, 12)}), but ${row.version} on disk is now ` +
          `'${migrationSlug(diskFile)}' (hash ${diskHash.slice(0, 12)}). A migration was renumbered ` +
          `or replaced after being applied. Restore the original file at this version number, or if ` +
          `this is deliberate, reconcile schema_version by hand — astramemory-local will not guess ` +
          `(issue #188).`,
        );
      }
    }
  });
  verifyAndBackfill();

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

/**
 * Read the dim actually baked into `memories_vec` at CREATE TABLE time
 * (FEAT-409 AC-3) by parsing its persisted DDL out of sqlite_master —
 * the source of truth for what the schema really is, independent of
 * whatever config.embedding.dim currently says. Boot preflight compares
 * the PROVIDER's dim against this (not just provider self-consistency),
 * so a config/provider dim that drifted from the schema (e.g. someone
 * edited config.yaml without running `reembed-dim`) fails loud at boot
 * instead of surfacing as a raw sqlite-vec dimension error deep in the
 * first ingest. Returns null when the table doesn't exist yet (fresh DB
 * about to be created by migrate()) or its DDL doesn't match the
 * expected `FLOAT[N]` shape.
 */
export function getVecSchemaDim(db: DB): number | null {
  const row = db
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'memories_vec'`)
    .get() as { sql: string } | undefined;
  if (!row?.sql) return null;
  const match = row.sql.match(/FLOAT\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}
