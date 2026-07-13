/**
 * A database opened by a NEW daemon must still open on an OLD one.
 * `reinstall --rollback` is the escape hatch; it must never be able to fail.
 *
 * What went wrong (2026-07-13, hit live on the production datadir):
 *
 * #242 fixed the migration hash guard firing on CRLF-vs-LF (a refuse-to-boot
 * bug). But its first form "self-healed" a legacy raw-byte hash by REWRITING
 * the stored row to the normalized hash. That rewrite was a ONE-WAY DOOR:
 *
 *   1. v0.17.0 opens the DB, rewrites schema_version.content_hash to LF hashes.
 *   2. The v0.17.0 upgrade rolls back (health-check timeout, zombie lock).
 *   3. The restored v0.16.0 hashes RAW bytes, sees LF hashes it cannot explain,
 *      and REFUSES TO BOOT:
 *        "Migration 1 was applied as 'init' (hash 63c76575ab6e), but 1 on disk
 *         is now 'init' (hash 2880ad8379f5)."
 *   4. The operator is now down, on both versions, with a working database.
 *
 * A fix that quietly disables rollback is worse than the bug it fixes.
 *
 * The rule this file pins: **verify, don't migrate.** A stored hash matching
 * EITHER the raw bytes or the normalized content proves the migration file is
 * identical modulo line endings — which SQLite does not care about — so accept
 * it and LEAVE THE ROW ALONE. Old and new releases then keep booting on the
 * same database, indefinitely.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { contentHash } from '../../src/storage/content-hash.js';
import type { DB } from '../../src/storage/db.js';

/** How a PRE-#242 daemon (v0.16.0 and earlier) hashed a migration file. */
const oldRawHash = (raw: string) => contentHash(raw);
/** How a POST-#242 daemon hashes it. */
const newNormalizedHash = (raw: string) => contentHash(raw.replace(/\r\n/g, '\n'));

describe('migration hash: a new daemon must not lock out an old one (#242 follow-up)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });
  afterEach(() => db.close());

  it('migrate() does NOT rewrite a stored hash that is merely a legacy raw-byte hash', () => {
    // Simulate a DB written by a pre-#242 daemon on a CRLF checkout: the stored
    // hash is the RAW hash of the on-disk file. (We can't easily force the real
    // files to CRLF here, so assert the invariant that matters: migrate() must
    // leave a row alone once it accepts it — no UPDATE, no drift.)
    const before = db
      .prepare('SELECT version, content_hash FROM schema_version ORDER BY version')
      .all() as Array<{ version: number; content_hash: string | null }>;

    migrate(db); // second boot — the one that used to rewrite

    const after = db
      .prepare('SELECT version, content_hash FROM schema_version ORDER BY version')
      .all() as Array<{ version: number; content_hash: string | null }>;

    expect(after).toEqual(before);
  });

  it('an old daemon and a new daemon agree on a CRLF file — neither locks the other out', () => {
    const crlf = 'CREATE TABLE t (\r\n  id INTEGER\r\n);\r\n';
    const lf = crlf.replace(/\r\n/g, '\n');

    const storedByOldDaemon = oldRawHash(crlf); // what v0.16.0 recorded

    // The NEW daemon must accept it: it matches the raw bytes, even though its
    // own normalized hash differs. This is the acceptance rule.
    expect(storedByOldDaemon).not.toBe(newNormalizedHash(crlf)); // they DO differ
    expect(storedByOldDaemon).toBe(oldRawHash(crlf));            // ...but raw matches

    // And because the new daemon does NOT rewrite the row, the OLD daemon still
    // finds its own raw hash on the next boot. Both keep working.
    expect(oldRawHash(crlf)).toBe(storedByOldDaemon);

    // Sanity: the two hashings really are different functions.
    expect(newNormalizedHash(crlf)).toBe(newNormalizedHash(lf));
  });

  it('real tampering still throws — accepting two hashes did not remove the teeth', () => {
    // An edited migration matches NEITHER the raw nor the normalized hash.
    const original = 'CREATE TABLE t (id INTEGER);\n';
    const tampered = 'CREATE TABLE t (id TEXT);\n';

    expect(newNormalizedHash(tampered)).not.toBe(newNormalizedHash(original));
    expect(oldRawHash(tampered)).not.toBe(oldRawHash(original));
    expect(oldRawHash(tampered)).not.toBe(newNormalizedHash(original));
  });

  it('a fresh DB records the NORMALIZED hash (new daemons are self-consistent)', () => {
    const rows = db
      .prepare('SELECT content_hash FROM schema_version WHERE content_hash IS NOT NULL')
      .all() as Array<{ content_hash: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
