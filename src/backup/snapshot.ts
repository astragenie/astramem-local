/**
 * snapshot.ts — online-safe SQLite backup using better-sqlite3's built-in
 * backup API (which uses the SQLite Online Backup API under the hood).
 *
 * Falls back to VACUUM INTO if the better-sqlite3 version does not expose
 * db.backup().
 */
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Database } from 'better-sqlite3';

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
 * to `VACUUM INTO` otherwise.
 *
 * @param db      An open better-sqlite3 Database instance.
 * @param outPath Absolute destination path for the snapshot file.
 * @returns       Metadata about the written snapshot.
 */
export async function createSnapshot(
  db: Database,
  outPath: string
): Promise<SnapshotResult> {
  // Ensure parent directory exists
  mkdirSync(dirname(outPath), { recursive: true });

  const start = Date.now();

  if (typeof (db as any).backup === 'function') {
    // better-sqlite3 >= 7.6 exposes db.backup(path) which uses the
    // SQLite Online Backup API — safe to run while the DB is in use.
    await (db as any).backup(outPath);
  } else {
    // Older better-sqlite3 builds: fall back to VACUUM INTO (still online-safe
    // per SQLite docs — reads a consistent snapshot, does not block writes).
    db.exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
  }

  const duration_ms = Date.now() - start;
  const { size: size_bytes } = statSync(outPath);

  return { path: outPath, size_bytes, duration_ms };
}
