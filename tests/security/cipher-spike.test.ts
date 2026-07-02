// SPIKE (Wave 1 task 1a): does better-sqlite3-multiple-ciphers (SQLCipher-compatible
// drop-in for better-sqlite3) load the sqlite-vec extension and run vector queries on
// an ENCRYPTED database? Decides the ADR-002 1b encryption path.
//
// This test intentionally does NOT import src/storage/db.ts — it drives
// better-sqlite3-multiple-ciphers directly, mirroring db.ts's sqlite-vec load
// mechanism (sqliteVec.load(db)) so the result generalizes to the real driver swap.
//
// Go/no-go rule (see docs/superpowers/specs/2026-07-02-cipher-spike-outcome.md):
// CI green on ubuntu + macos + windows -> 1b proceeds with the driver swap.
// Any OS fails -> ADR-002 fallback: app-level encryption of text/evidence/transcripts columns.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import CipherDatabase from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';

const CIPHER_KEY = "spike-key-do-not-use-in-prod-42";
const DIM = 1024;

function vec(seed: number): Float32Array {
  const v = new Float32Array(DIM);
  for (let i = 0; i < DIM; i++) v[i] = Math.sin(seed + i * 0.01);
  return v;
}

describe('cipher spike: better-sqlite3-multiple-ciphers + sqlite-vec on an encrypted DB', () => {
  let dir: string | undefined;
  let dbPath: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
      dbPath = undefined;
    }
  });

  it('loads sqlite-vec + runs a KNN query on an encrypted temp-file DB, and encryption is real', () => {
    dir = mkdtempSync(join(tmpdir(), 'astramem-cipher-spike-'));
    dbPath = join(dir, 'spike.db');

    // --- a) open temp-file DB, apply PRAGMA key immediately after open ---
    const db = new CipherDatabase(dbPath);
    db.pragma(`key='${CIPHER_KEY}'`);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');

    // --- b) load sqlite-vec exactly the way src/storage/db.ts does ---
    sqliteVec.load(db);

    // --- c) create vec0 virtual table, insert 3 distinct vectors, KNN query ---
    db.exec(`CREATE VIRTUAL TABLE v USING vec0(embedding FLOAT[${DIM}])`);

    const vA = vec(1);      // near-query vector
    const vB = vec(1.01);   // second-nearest
    const vC = vec(50);     // far

    const insert = db.prepare('INSERT INTO v (rowid, embedding) VALUES (?, ?)');
    insert.run(BigInt(1), Buffer.from(vA.buffer));
    insert.run(BigInt(2), Buffer.from(vB.buffer));
    insert.run(BigInt(3), Buffer.from(vC.buffer));

    const hits = db.prepare(`
      SELECT rowid, distance FROM v WHERE embedding MATCH ? AND k = ?
    `).all(Buffer.from(vec(1).buffer), 3) as { rowid: number; distance: number }[];

    expect(hits).toHaveLength(3);
    // sane ordering: nearest first, ascending distance
    expect(hits[0]!.rowid).toBe(1);
    expect(hits[1]!.rowid).toBe(2);
    expect(hits[2]!.rowid).toBe(3);
    expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
    expect(hits[1]!.distance).toBeLessThan(hits[2]!.distance);

    db.close();

    // --- f) raw file header must NOT be plaintext "SQLite format 3" ---
    const header = readFileSync(dbPath).subarray(0, 16).toString('latin1');
    expect(header.startsWith('SQLite format 3')).toBe(false);

    // --- d) reopen WITHOUT the key -> reading must fail (proves encryption is real) ---
    const dbNoKey = new CipherDatabase(dbPath);
    expect(() => {
      dbNoKey.prepare('SELECT rowid FROM v').all();
    }).toThrow();
    dbNoKey.close();

    // --- e) reopen WITH the key -> data intact ---
    const dbWithKey = new CipherDatabase(dbPath);
    dbWithKey.pragma(`key='${CIPHER_KEY}'`);
    sqliteVec.load(dbWithKey);
    const rows = dbWithKey.prepare('SELECT rowid FROM v ORDER BY rowid').all() as { rowid: number }[];
    expect(rows.map(r => r.rowid)).toEqual([1, 2, 3]);
    const reopenedHits = dbWithKey.prepare(`
      SELECT rowid, distance FROM v WHERE embedding MATCH ? AND k = ?
    `).all(Buffer.from(vec(1).buffer), 3) as { rowid: number; distance: number }[];
    expect(reopenedHits[0]!.rowid).toBe(1);
    dbWithKey.close();
  });

  it('wrong key also fails to read (not just a missing key)', () => {
    dir = mkdtempSync(join(tmpdir(), 'astramem-cipher-spike-wrongkey-'));
    dbPath = join(dir, 'spike-wrongkey.db');

    const db = new CipherDatabase(dbPath);
    db.pragma(`key='${CIPHER_KEY}'`);
    db.exec('CREATE TABLE t (x INTEGER)');
    db.prepare('INSERT INTO t VALUES (1)').run();
    db.close();

    const dbWrongKey = new CipherDatabase(dbPath);
    dbWrongKey.pragma(`key='totally-different-key'`);
    expect(() => {
      dbWrongKey.prepare('SELECT x FROM t').all();
    }).toThrow();
    dbWrongKey.close();
  });
});
