import { existsSync, statSync } from 'node:fs';
import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';

export type DB = Database.Database;

export interface OpenDbOpts {
  /**
   * Encryption key (SEC-1/2). Applied via `PRAGMA key` immediately after
   * open, before any other pragma and before the sqlite-vec extension load.
   * Ignored for `:memory:` databases — SQLCipher rejects `PRAGMA key` on
   * in-memory/temporary databases (confirmed by the 1a spike), so in-memory
   * opens are always plaintext regardless of whether a key is supplied.
   */
  key?: string;
}

/**
 * Thrown by `openDb` when the file on disk cannot be trusted as an intact
 * datadir (FEAT-420 AC-3), and NO encryption key was in play. Distinct from
 * a raw `SqliteError` so callers and operators get an actionable message
 * instead of a low-level driver string.
 */
export class CorruptDatadirError extends Error {
  constructor(path: string, reason: string) {
    super(
      `Refusing to open ${path}: ${reason}. This looks like a corrupted or truncated ` +
      `SQLite datadir, not a fresh install — a fresh install never pre-creates this file. ` +
      `Restore from a backup ('astramem-local restore') or, if you are certain there is no ` +
      `data to lose, delete the file (and any -wal/-shm siblings) and restart to create a fresh one.`,
    );
    this.name = 'CorruptDatadirError';
  }
}

/**
 * Thrown by `openDb` when a key WAS supplied but the file could not be read
 * with it (FEAT-420 AC-3 review fix). SQLCipher cannot distinguish
 * "wrong/missing key" from "corrupted file" at the driver level — both
 * surface as the exact same `SqliteError: file is not a database`
 * (SQLITE_NOTADB), which is also the documented stale-v0.3.4-global-install
 * symptom (CLAUDE.md "Do NOT use bare astramem-local"). Reusing
 * CorruptDatadirError's corruption-and-delete advice here would actively
 * steer an operator with a recoverable key/config problem toward destroying
 * a healthy encrypted database — so this is a distinct class with distinct,
 * non-destructive advice and NO deletion suggestion.
 */
export class EncryptionKeyError extends Error {
  constructor(path: string, reason: string) {
    super(
      `Refusing to open ${path}: ${reason}. A key was supplied but could not decrypt this file — ` +
      `this is the classic wrong-or-missing-encryption-key symptom, not necessarily corruption ` +
      `(SQLCipher cannot tell the two apart at this layer). Before assuming data loss, check: ` +
      `(1) the key material in secrets.env matches what encrypted this file; ` +
      `(2) you are running the repo build ('node dist/cli/index.js ...'), not a stale globally-` +
      `installed 'astramem-local' shadowing it with a different cipher driver; ` +
      `(3) the key hasn't rotated without re-encrypting this file. Leave this file untouched until ` +
      `one of those is resolved — it may still hold your data intact.`,
    );
    this.name = 'EncryptionKeyError';
  }
}

export function openDb(path: string, opts: OpenDbOpts = {}): DB {
  // FEAT-420 AC-3: a pre-existing but EMPTY (0-byte) file is silently
  // accepted by SQLite as a brand-new database — better-sqlite3 just
  // initializes it, and migrate() then happily builds a pristine empty
  // schema on top, masking what is actually a truncated/corrupted datadir
  // as data loss with no error at all. A genuinely fresh install never has
  // a pre-existing file at this path (the file doesn't exist until this
  // call creates it), so "file exists AND is 0 bytes" is an unambiguous
  // signal of truncation, not a legitimate first run.
  if (path !== ':memory:' && existsSync(path) && statSync(path).size === 0) {
    throw new CorruptDatadirError(path, 'file exists but is empty (0 bytes)');
  }
  try {
    const db = new Database(path);
    if (path !== ':memory:' && opts.key) {
      db.pragma(`key='${opts.key.replace(/'/g, "''")}'`);
    }
    // Block-and-retry for up to 5s on a locked database instead of throwing
    // SQLITE_BUSY immediately — covers concurrent writers (backup CLI's
    // second connection, doctor probes) against the live daemon.
    db.pragma('busy_timeout = 5000');
    // better-sqlite3 opens the file handle lazily — "file is not a
    // database" / "database disk image is malformed" (garbage bytes, a
    // truncated real file) only surface on the FIRST pragma/exec that
    // actually reads a page, not at `new Database()` itself. Everything
    // through the vec extension load is wrapped so any of these still
    // become the same actionable typed error as the 0-byte case above.
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    sqliteVec.load(db);
    return db;
  } catch (err) {
    const alreadyTyped = err instanceof CorruptDatadirError || err instanceof EncryptionKeyError;
    if (path !== ':memory:' && err instanceof Error && !alreadyTyped) {
      // A key was supplied (opts.key) -> the same raw driver error is the
      // wrong/missing-key symptom, not necessarily corruption — see
      // EncryptionKeyError's doc comment. Only diagnose corruption when no
      // key was ever in play.
      if (opts.key) {
        throw new EncryptionKeyError(path, err.message);
      }
      throw new CorruptDatadirError(path, err.message);
    }
    throw err;
  }
}
