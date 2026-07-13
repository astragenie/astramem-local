/**
 * The migration content-hash guard (#212/#188) must not fire on a line-ending
 * difference — that made it a REFUSE-TO-BOOT bug.
 *
 * What happened (2026-07-13): the guard hashed a migration file's RAW bytes.
 * Git's `core.autocrlf=true` — the Windows default — checks the SAME committed
 * file out as CRLF in one working tree and LF in another. Measured on
 * 027-entity-relations.sql: 4593 bytes / 0 CR in one checkout, 4674 bytes /
 * 81 CR in another, `git status` clean in both, identical SHA once the CRs are
 * stripped. Same file, same commit, different bytes.
 *
 * The daemon then refused to start:
 *
 *   Migration 27 was applied as 'entity-relations' (hash 9e35fb0024e3), but 27
 *   on disk is now 'entity-relations' (hash 4b5e9ced33da). A migration was
 *   renumbered or replaced after being applied.
 *
 * It was not. A guard that halts the daemon over a carriage return is worse
 * than no guard: it teaches the operator to reach for
 * `ASTRA_ALLOW_...`-style overrides, which is precisely the reflex the guard
 * exists to make unnecessary.
 */
import { describe, it, expect } from 'vitest';
import { contentHash } from '../../src/storage/content-hash.js';

/** Mirrors the local helper in migrate.ts's verifyAndBackfill. */
const migrationFileHash = (raw: string): string => contentHash(raw.replace(/\r\n/g, '\n'));

const SQL_LF = 'CREATE TABLE t (\n  id INTEGER PRIMARY KEY\n);\n';
const SQL_CRLF = SQL_LF.replace(/\n/g, '\r\n');

describe('migration content hash — line-ending normalization (#212 follow-up)', () => {
  it('the same migration checked out LF vs CRLF hashes IDENTICALLY', () => {
    // This is the whole bug. Before the fix these differed and the daemon
    // refused to boot.
    expect(migrationFileHash(SQL_CRLF)).toBe(migrationFileHash(SQL_LF));
  });

  it('raw-byte hashing DID differ — proving the test above is not vacuous', () => {
    // If this ever starts passing, the normalization is being applied somewhere
    // upstream and the test above stops proving anything.
    expect(contentHash(SQL_CRLF)).not.toBe(contentHash(SQL_LF));
  });

  it('a REAL edit still changes the hash — the guard keeps its teeth', () => {
    const tampered = SQL_LF.replace('id INTEGER', 'id TEXT');
    expect(migrationFileHash(tampered)).not.toBe(migrationFileHash(SQL_LF));
  });

  it('a renumber/replace (different SQL entirely) still changes the hash', () => {
    const other = 'CREATE TABLE completely_different (x INTEGER);\n';
    expect(migrationFileHash(other)).not.toBe(migrationFileHash(SQL_LF));
  });

  it('normalization is idempotent — an already-LF file is untouched', () => {
    expect(migrationFileHash(SQL_LF)).toBe(contentHash(SQL_LF));
  });

  it('a lone CR (not CRLF) is NOT rewritten — only line endings are normalized', () => {
    // `\r` inside content is data, not a line ending. Only the CRLF pair is
    // collapsed, so this must remain distinct from its LF-substituted twin.
    const loneCr = 'CREATE TABLE t (x TEXT DEFAULT \'a\rb\');\n';
    const substituted = 'CREATE TABLE t (x TEXT DEFAULT \'a\nb\');\n';
    expect(migrationFileHash(loneCr)).not.toBe(migrationFileHash(substituted));
  });
});
