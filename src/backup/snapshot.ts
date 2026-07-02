/**
 * snapshot.ts — online-safe SQLite backup using better-sqlite3's built-in
 * backup API (which uses the SQLite Online Backup API under the hood).
 *
 * Falls back to VACUUM INTO if the better-sqlite3 version does not expose
 * db.backup().
 */
import { mkdirSync, statSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DB } from '../storage/db.js';

export interface SnapshotResult {
  path: string;
  size_bytes: number;
  duration_ms: number;
}

/**
 * Create an online-safe snapshot of `db` to `outPath`.
 *
 * The directory containing outPath is created if it does not exist.
 * Uses db.backup() (online-safe, zero downtime) when available; falls back
 * to `VACUUM INTO` otherwise. When `db` is an encrypted (SQLCipher) database,
 * the backup/VACUUM INTO output is encrypted with the same key — SQLite's
 * online backup API and VACUUM INTO both operate on the live connection's
 * pages, so ciphertext pages are copied as ciphertext (SEC-8).
 *
 * @param db      An open better-sqlite3-multiple-ciphers Database instance.
 * @param outPath Absolute destination path for the snapshot file.
 * @returns       Metadata about the written snapshot.
 */
export async function createSnapshot(
  db: DB,
  outPath: string
): Promise<SnapshotResult> {
  // Ensure parent directory exists
  mkdirSync(dirname(outPath), { recursive: true });

  const start = Date.now();

  const vacuumInto = () => {
    // VACUUM INTO is online-safe per SQLite docs (consistent snapshot, does
    // not block writes). Under SQLite3MultipleCiphers the output inherits the
    // main database's encryption, so ciphertext stays ciphertext (SEC-8).
    rmSync(outPath, { force: true }); // VACUUM INTO refuses existing targets
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  };

  if (typeof (db as any).backup === 'function') {
    // better-sqlite3 >= 7.6 exposes db.backup(path) which uses the
    // SQLite Online Backup API — safe to run while the DB is in use.
    // On an ENCRYPTED connection the cipher driver rejects the plaintext
    // target with "backup is not supported with incompatible source and
    // target databases" — fall back to VACUUM INTO in that case.
    try {
      await (db as any).backup(outPath);
    } catch {
      vacuumInto();
    }
  } else {
    vacuumInto();
  }

  const duration_ms = Date.now() - start;
  const { size: size_bytes } = statSync(outPath);

  return { path: outPath, size_bytes, duration_ms };
}
