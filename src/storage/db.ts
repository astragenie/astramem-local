import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export type DB = Database.Database;

export function openDb(path: string): DB {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  sqliteVec.load(db);
  return db;
}
