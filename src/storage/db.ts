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
 * datadir (FEAT-420 AC-3). Distinct from a raw `SqliteError` so callers and
 * operators get an actionable message instead of a low-level driver string.
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
    if (path !== ':memory:' && err instanceof Error && !(err instanceof CorruptDatadirError)) {
      throw new CorruptDatadirError(path, err.message);
    }
    throw err;
  }
}
