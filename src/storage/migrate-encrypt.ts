/**
 * migrate-encrypt.ts — plaintext -> encrypted DB auto-migration (SEC-7, AC-2).
 *
 * On daemon startup, a pre-existing v0.3.x plaintext `memory.sqlite` must be
 * transparently upgraded to an encrypted (SQLCipher) file before openDb()
 * applies `PRAGMA key` to it. Detection is a raw byte-header check (no need
 * to even open the file to know it's plaintext): every unencrypted SQLite
 * file begins with the 16-byte magic string `"SQLite format 3\0"`.
 *
 * Migration path (`PRAGMA rekey`, the SQLite3MultipleCiphers mechanism —
 * this driver does NOT ship SQLCipher's `sqlcipher_export()` function):
 *   1. Open the plaintext file with the cipher driver WITHOUT a key
 *      (the driver reads plaintext SQLite files natively when no key is set),
 *      `PRAGMA wal_checkpoint(TRUNCATE)` to fold any -wal sidecar into the
 *      main file, record row counts, close.
 *   2. Copy the (now checkpoint-complete) file to a tmp path and run
 *      `PRAGMA rekey = '<key>'` on the COPY — in-place encryption of every
 *      page. The original stays untouched until verification passes.
 *   3. Verify: the tmp header is no longer plaintext magic AND reopening tmp
 *      with the key reproduces the `memories` + `transcripts` row counts.
 *      Abort (throw, delete tmp, original untouched) on any mismatch.
 *   4. Copy the plaintext original to `<dbPath>.pre-encryption.bak` (kept
 *      per SEC-7 until the operator is confident the migration is safe —
 *      this module does not delete it), then atomically rename the tmp file
 *      over `dbPath`.
 *
 * Idempotent: a second call against an already-encrypted file (header is no
 * longer the plaintext magic) is a no-op that returns 'already-encrypted'.
 */
import { readFileSync, existsSync, copyFileSync, renameSync, rmSync } from 'node:fs';
import CipherDatabase from 'better-sqlite3-multiple-ciphers';
import type { DB } from './db.js';

const PLAINTEXT_MAGIC = 'SQLite format 3\0';

export type EncryptMigrationResult = 'migrated' | 'already-encrypted' | 'missing';

function isPlaintextSqlite(dbPath: string): boolean {
  const header = readFileSync(dbPath).subarray(0, 16).toString('latin1');
  return header === PLAINTEXT_MAGIC;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function tableCounts(db: DB): { memories: number; transcripts: number } {
  const memories = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
  const transcripts = (db.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as { n: number }).n;
  return { memories, transcripts };
}

/**
 * Detects a plaintext DB at `dbPath` and migrates it to encrypted form with
 * `key`. Returns:
 *   - 'missing'           — no file at dbPath (fresh install; openDb() with
 *                            a key will create an encrypted file directly).
 *   - 'already-encrypted' — file exists and is not plaintext (already
 *                            migrated, or created encrypted from the start).
 *   - 'migrated'          — a plaintext DB was found and successfully
 *                            converted; `<dbPath>.pre-encryption.bak` now
 *                            holds the pre-migration plaintext copy.
 */
export function encryptIfPlaintext(dbPath: string, key: string): EncryptMigrationResult {
  if (!existsSync(dbPath)) return 'missing';
  if (!isPlaintextSqlite(dbPath)) return 'already-encrypted';

  const tmpPath = `${dbPath}.encrypting-tmp`;
  if (existsSync(tmpPath)) {
    // Leftover from a crashed/interrupted prior attempt — start clean.
    rmSync(tmpPath, { force: true });
  }

  // 1. Checkpoint + count on the ORIGINAL, then close it before copying.
  const plain = new CipherDatabase(dbPath);
  let beforeCounts: { memories: number; transcripts: number };
  try {
    try {
      plain.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Non-fatal: DB may not be in WAL mode yet (e.g. first-ever open).
    }
    beforeCounts = tableCounts(plain);
  } finally {
    plain.close();
  }

  // 2. Encrypt a COPY in place via PRAGMA rekey (plaintext -> keyed).
  copyFileSync(dbPath, tmpPath);
  const rekeying = new CipherDatabase(tmpPath);
  try {
    rekeying.pragma(`rekey='${escapeSqlString(key)}'`);
  } finally {
    rekeying.close();
  }

  // 3. Verify the copy is genuinely encrypted and complete before touching
  //    the original file.
  if (isPlaintextSqlite(tmpPath)) {
    rmSync(tmpPath, { force: true });
    throw new Error(
      `encryptIfPlaintext: PRAGMA rekey left ${tmpPath} with a plaintext header; ` +
      `aborting — plaintext DB at ${dbPath} was left untouched`,
    );
  }
  const verify = new CipherDatabase(tmpPath);
  let afterCounts: { memories: number; transcripts: number };
  try {
    verify.pragma(`key='${escapeSqlString(key)}'`);
    afterCounts = tableCounts(verify);
  } finally {
    verify.close();
  }

  if (afterCounts.memories !== beforeCounts.memories || afterCounts.transcripts !== beforeCounts.transcripts) {
    rmSync(tmpPath, { force: true });
    throw new Error(
      `encryptIfPlaintext: row count mismatch after rekey ` +
      `(memories ${beforeCounts.memories} -> ${afterCounts.memories}, ` +
      `transcripts ${beforeCounts.transcripts} -> ${afterCounts.transcripts}); ` +
      `aborting — plaintext DB at ${dbPath} was left untouched`,
    );
  }

  // Preserve the plaintext original (SEC-7), then atomically swap it out.
  const bakPath = `${dbPath}.pre-encryption.bak`;
  copyFileSync(dbPath, bakPath);
  renameSync(tmpPath, dbPath);

  return 'migrated';
}
