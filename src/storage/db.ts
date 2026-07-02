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

export function openDb(path: string, opts: OpenDbOpts = {}): DB {
  const db = new Database(path);
  if (path !== ':memory:' && opts.key) {
    db.pragma(`key='${opts.key.replace(/'/g, "''")}'`);
  }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  sqliteVec.load(db);
  return db;
}
