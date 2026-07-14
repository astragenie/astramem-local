import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DB } from './db.js';
import { SCHEMA_VERSION } from '../server/lib/wire-meta.js';
import { MIGRATIONS_DIR } from './schema-version.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';
import { contentHash } from './content-hash.js';

/**
 * Thrown by migrate() when the DB's applied schema is NEWER than this daemon's
 * SCHEMA_VERSION (issue #306) — a running service pinned to an older release
 * than the CLI that last migrated the datadir. Distinct from the generic
 * dev-facing "constant drift" Error so serve.ts can print one-line operator
 * guidance (run `reinstall`) instead of a stack trace, and so it can be told
 * apart programmatically from a genuine developer bump-the-constant mistake.
 */
export class SchemaNewerThanDaemonError extends Error {
  readonly dbSchema: number;
  readonly daemonSchema: number;
  constructor(dbSchema: number, daemonSchema: number) {
    super(
      `This datadir was migrated by a NEWER astramem-local (DB schema ${dbSchema}) ` +
      `than the one now running (daemon schema ${daemonSchema}). The service is pinned ` +
      `to an older release. Run \`astramem-local reinstall\` to repoint the service at ` +
      `the current release, then restart it.`,
    );
    this.name = 'SchemaNewerThanDaemonError';
    this.dbSchema = dbSchema;
    this.daemonSchema = daemonSchema;
  }
}

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

  // --- issue #188 follow-up: duplicate-version-on-disk guard ---------------
  // The content-hash check above (and migration-renumber.test.ts's static
  // "no two files share a number" test) both protect against a migration
  // being RENUMBERED after being applied. Neither protects against the
  // OTHER shape of the 2026-07-13 incident: two files claiming the SAME
  // number at once, on disk, RIGHT NOW -- e.g. two concurrent branches each
  // adding their own "035-something.sql" and merging without anyone
  // renumbering. Without this check, whichever file `readdirSync` happens to
  // sort first "wins": its INSERT INTO schema_version (version) succeeds,
  // and the second file's INSERT hits the `version` column's PRIMARY KEY
  // constraint -- which the loop below reports as a "half-migrated or
  // corrupted datadir" (FEAT-420 AC-3's diagnosis for a DIFFERENT failure
  // mode entirely, and actively wrong here: nothing is corrupted, two files
  // are just fighting over one slot). Catching it here, before any DDL runs,
  // gives a precise, correct diagnosis on a fresh install too -- not just an
  // already-migrated one.
  const filesByVersion = new Map<number, string[]>();
  for (const f of files) {
    const version = parseInt(f.split('-')[0] ?? '', 10);
    if (Number.isNaN(version)) continue; // reported below by the per-file bad-name check
    const existing = filesByVersion.get(version);
    if (existing) existing.push(f);
    else filesByVersion.set(version, [f]);
  }
  for (const [version, sameVersionFiles] of filesByVersion) {
    if (sameVersionFiles.length > 1) {
      throw new Error(
        `${sameVersionFiles.map(f => `migrations/${f}`).join(' and ')} share version ${version} -- ` +
        `one of them will never run. migrate() keys a migration's identity on this number; give each ` +
        `file a unique version (issue #188).`,
      );
    }
  }

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
  // Migration 035 adds `filename`/`content_hash` columns to schema_version
  // (applied above, through the normal loop, like any other migration — by
  // this point dbMax is guaranteed to equal SCHEMA_VERSION, so the columns
  // are guaranteed to exist). The INSERT in the loop above never populates
  // them (it can't — on a genuinely fresh DB, every earlier migration applies
  // *before* 035 adds the columns at all), so every row reaching this point
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
  // (The duplicate-version guard above already proved every version maps to
  // at most one file, so it's safe to flatten filesByVersion's arrays here.)
  const fileByVersion = new Map<number, string>();
  for (const [version, sameVersionFiles] of filesByVersion) {
    fileByVersion.set(version, sameVersionFiles[0]!);
  }

  const versionRows = db
    .prepare('SELECT version, filename, content_hash FROM schema_version ORDER BY version')
    .all() as { version: number; filename: string | null; content_hash: string | null }[];

  const backfillStmt = db.prepare(
    'UPDATE schema_version SET filename = ?, content_hash = ? WHERE version = ?',
  );

  /**
   * Hash a migration file's LOGICAL content — line endings normalized to LF.
   *
   * NOT `contentHash(raw)`. Hashing raw bytes made this guard fire on a file
   * that had not changed at all:
   *
   *   Migration 27 was applied as 'entity-relations' (hash 9e35fb0024e3),
   *   but 27 on disk is now 'entity-relations' (hash 4b5e9ced33da).
   *   A migration was renumbered or replaced after being applied.
   *
   * It was not. Git's `core.autocrlf=true` (the Windows default, and set on the
   * maintainer's box) checks the same committed file out as CRLF in one working
   * tree and LF in another. Measured on 027-entity-relations.sql: 4593 bytes /
   * 0 CR in one checkout, 4674 bytes / 81 CR in another, `git status` clean in
   * both, and identical SHA once the CRs are stripped. Same file. Same commit.
   * Different bytes.
   *
   * That made this a REFUSE-TO-BOOT bug: a daemon whose hashes were recorded
   * from an LF checkout, upgraded to a release materialized from a CRLF
   * checkout, halts at startup and tells the operator to "reconcile
   * schema_version by hand" over a difference that does not exist.
   *
   * Normalizing is safe *for this purpose*: SQLite does not care about line
   * endings, so two migration files differing only in CR bytes apply the exact
   * same schema. The guard exists to catch a migration being RENUMBERED or
   * REPLACED after it was applied — a semantic change — and a CR byte is not
   * one. Every real tampering case still trips it.
   *
   * Deliberately a LOCAL helper, not a change to `contentHash`: that function
   * also hashes MEMORY text for dedup (astramem-local#84), where the raw bytes
   * are the contract. Normalizing there would silently re-key every existing
   * memory and break dedup across the whole store.
   */
  const migrationFileHash = (raw: string): string => contentHash(raw.replace(/\r\n/g, '\n'));

  const verifyAndBackfill = db.transaction(() => {
    for (const row of versionRows) {
      const diskFile = fileByVersion.get(row.version);
      if (!diskFile) continue; // no file on disk for this version anymore — nothing to check against

      const diskHash = migrationFileHash(readFileSync(join(MIGRATIONS_DIR, diskFile), 'utf8'));

      if (row.content_hash == null) {
        backfillStmt.run(diskFile, diskHash, row.version);
        continue;
      }

      if (row.content_hash !== diskHash) {
        // ACCEPT a legacy RAW-byte hash. Do NOT rewrite it.
        //
        // Rows written by the original #212 guard hashed raw bytes; on a CRLF
        // checkout that recorded a CRLF hash. #242 started hashing normalized
        // content, so those rows no longer match — and an earlier version of
        // this block "self-healed" them by REWRITING the stored hash to the
        // normalized form.
        //
        // That rewrite was a ONE-WAY DOOR, and it broke `reinstall --rollback`.
        // Once a v0.17.0 daemon touched a database, every OLDER release — which
        // still hashes raw bytes — saw a mismatch it could not explain and
        // REFUSED TO BOOT. Hit live on 2026-07-13: the 0.17.0 upgrade rolled
        // back on a health-check timeout, and the restored 0.16.0 then could not
        // start on its own database ("Migration 1 was applied as 'init' ...").
        // Rolling back is the one thing that must never be able to fail; a fix
        // that quietly disables it is worse than the bug it fixes.
        //
        // So: verify, don't migrate. A stored hash matching EITHER the raw bytes
        // or the normalized content proves the file is byte-identical modulo
        // line endings — which SQLite does not care about, so the applied schema
        // is provably the same. Accept it, leave the row alone, and both old and
        // new releases keep booting on the same database, forever.
        //
        // Cannot mask real tampering: a renumbered or edited migration matches
        // NEITHER hash and still throws below.
        const rawHash = contentHash(readFileSync(join(MIGRATIONS_DIR, diskFile), 'utf8'));
        if (row.content_hash === rawHash) continue;

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
  if (dbMax > SCHEMA_VERSION) {
    // The DB was migrated by a NEWER astramem-local than the one now running
    // (issue #306). This is the upgrade footgun: `npm i -g` bumped the CLI, the
    // new CLI opened + migrated the datadir, but the schtasks/systemd service is
    // still pinned to an OLDER materialized release that cannot serve the newer
    // schema. This is an OPERATOR condition with a known fix — not the dev-facing
    // "you forgot to bump the constant" case below — so it gets its own error
    // type and an actionable message. serve.ts catches this to print one-line
    // guidance instead of a stack trace + crash-loop.
    throw new SchemaNewerThanDaemonError(dbMax, SCHEMA_VERSION);
  }
  if (dbMax < SCHEMA_VERSION) {
    // Genuine developer drift: the SCHEMA_VERSION constant was bumped (or a
    // migration file was removed) without a matching applied migration in this
    // DB. Keep the original dev-facing message.
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
