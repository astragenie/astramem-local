// Wave 1 task 1b — encryption at rest (SEC-1/2/7/8, half of SEC-9).
// AC-1/AC-2/AC-6 and the encryption parts of AC-5.
//
// This suite exercises the real production driver
// (better-sqlite3-multiple-ciphers) against temp-file DBs — :memory: cannot
// be encrypted (PRAGMA key is rejected on in-memory DBs, confirmed by the 1a
// spike), so every test here uses a real file under a mkdtempSync tempdir.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';
import CipherDatabase from 'better-sqlite3-multiple-ciphers';

import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { encryptIfPlaintext } from '../../src/storage/migrate-encrypt.js';
import {
  getOrCreateKey,
  __setEntryCtorForTests,
  keyFilePath,
} from '../../src/storage/keystore.js';
import { createSnapshot } from '../../src/backup/snapshot.js';

const PLAINTEXT_MAGIC = 'SQLite format 3\0';

function fileHeader(path: string): string {
  return readFileSync(path).subarray(0, 16).toString('latin1');
}

function vec(seed: number): Float32Array {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed + i * 0.01);
  return v;
}

function makeMemory(repo: MemoryRepo, hash: string): string {
  return repo.insert({
    type: 'fact',
    text: `text for ${hash}`,
    normalized_text: `text for ${hash}`,
    hash,
    repo: null,
    project: null,
    branch: null,
    agent: null,
    session_id: null,
    source_hash: null,
  });
}

let tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    // maxRetries: Windows briefly holds native file handles after Database.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tmpDirs = [];
  __setEntryCtorForTests(undefined); // restore real Entry after any stubbing
});

// ─────────────────────────────────────────────────────────────────────────
// AC-1: fresh file-backed encrypted DB — header, CRUD, FTS, vec search
// ─────────────────────────────────────────────────────────────────────────

describe('AC-1: fresh encrypted DB lifecycle', () => {
  it('creates a file whose header is not the plaintext SQLite magic, and CRUD + FTS + vec search all work', async () => {
    const dir = mkTmpDir('astramem-enc-fresh-');
    const dbPath = join(dir, 'memory.sqlite');
    const key = randomBytes(32).toString('hex');

    const db = openDb(dbPath, { key });
    migrate(db);

    const repo = new MemoryRepo(db);
    const vecStore = new SqliteVecStore(db);
    const id = makeMemory(repo, 'enc-hash-1');
    await vecStore.upsert(id, vec(1));
    db.close();

    // Header must not be the plaintext magic — this is the actual at-rest
    // encryption evidence (SEC-1/2), not just an API claim.
    expect(fileHeader(dbPath)).not.toBe(PLAINTEXT_MAGIC);

    // Reopen WITH the key — CRUD, FTS, and vec search all round-trip.
    const reopened = openDb(dbPath, { key });
    const row = reopened.prepare('SELECT id, text FROM memories WHERE id = ?').get(id) as
      | { id: string; text: string }
      | undefined;
    expect(row?.id).toBe(id);

    const ftsHits = reopened
      .prepare(`SELECT m.id FROM memories_fts f JOIN memories m ON m.rowid = f.rowid WHERE memories_fts MATCH ?`)
      // Phrase-quoted: bare hyphens are NOT operators in FTS5 query syntax.
      .all('"enc-hash-1"') as { id: string }[];
    expect(ftsHits.map(h => h.id)).toContain(id);

    const vecStore2 = new SqliteVecStore(reopened);
    const hits = await vecStore2.search(vec(1), 1);
    expect(hits[0]?.id).toBe(id);
    reopened.close();

    // Reopen WITHOUT the key — reading must throw (proves the file is
    // actually encrypted, not just wrapped).
    const noKeyDb = new CipherDatabase(dbPath);
    expect(() => noKeyDb.prepare('SELECT id FROM memories').all()).toThrow();
    noKeyDb.close();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-2 (SEC-7): plaintext -> encrypted auto-migration
// ─────────────────────────────────────────────────────────────────────────

describe('AC-2: plaintext DB auto-migration (encryptIfPlaintext)', () => {
  it('migrates a plaintext DB with N memories to encrypted form, keeps a .pre-encryption.bak, and is idempotent', () => {
    const dir = mkTmpDir('astramem-enc-migrate-');
    const dbPath = join(dir, 'memory.sqlite');

    // Build a plaintext v0.3-style DB (openDb with no key = plaintext).
    const plainDb = openDb(dbPath);
    migrate(plainDb);
    plainDb
      .prepare(
        "INSERT INTO sessions (id, repo, project, branch, agent, started_at) VALUES ('s1', 'r', 'p', 'b', 'a', 0)",
      )
      .run();
    plainDb
      .prepare(
        "INSERT INTO transcripts (id, session_id, source, content, ingested_at) VALUES ('t1', 's1', 'plugin', 'hello', 0)",
      )
      .run();
    const repo = new MemoryRepo(plainDb);
    const N = 5;
    for (let i = 0; i < N; i++) makeMemory(repo, `pre-enc-${i}`);
    plainDb.close();

    expect(fileHeader(dbPath)).toBe(PLAINTEXT_MAGIC);

    const key = randomBytes(32).toString('hex');
    const result1 = encryptIfPlaintext(dbPath, key);
    expect(result1).toBe('migrated');

    // File is now encrypted.
    expect(fileHeader(dbPath)).not.toBe(PLAINTEXT_MAGIC);

    // .pre-encryption.bak holds the pre-migration plaintext copy.
    const bakPath = `${dbPath}.pre-encryption.bak`;
    expect(existsSync(bakPath)).toBe(true);
    expect(fileHeader(bakPath)).toBe(PLAINTEXT_MAGIC);

    // N memories intact when opened with the key.
    const encryptedDb = openDb(dbPath, { key });
    const count = (encryptedDb.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(count).toBe(N);
    const transcriptCount = (encryptedDb.prepare('SELECT COUNT(*) AS n FROM transcripts').get() as { n: number }).n;
    expect(transcriptCount).toBe(1);
    encryptedDb.close();

    // Second run does not re-migrate.
    const result2 = encryptIfPlaintext(dbPath, key);
    expect(result2).toBe('already-encrypted');
  });

  it('returns "missing" when no file exists at dbPath', () => {
    const dir = mkTmpDir('astramem-enc-missing-');
    const dbPath = join(dir, 'does-not-exist.sqlite');
    expect(encryptIfPlaintext(dbPath, 'irrelevant-key')).toBe('missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Keystore: credential-store + key-file fallback (SEC-2)
// ─────────────────────────────────────────────────────────────────────────

describe('keystore: getOrCreateKey provider chain', () => {
  it('key-file fallback: creates db.key with 0600 perms when the credential store is unavailable, and a second call returns the same key', () => {
    __setEntryCtorForTests(class {
      constructor(_service: string, _account: string) {
        throw new Error('simulated: no secret-service/dbus session (headless Linux)');
      }
      getPassword(): string | null { throw new Error('unreachable'); }
      setPassword(_p: string): void { throw new Error('unreachable'); }
      deleteCredential(): boolean { return false; }
      deletePassword(): boolean { return false; }
    } as unknown as typeof Entry);

    const configDir = mkTmpDir('astramem-enc-keyfile-');
    const first = getOrCreateKey(configDir);
    expect(first.source).toBe('key-file');
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);
    expect(existsSync(keyFilePath(configDir))).toBe(true);

    const second = getOrCreateKey(configDir);
    expect(second.source).toBe('key-file');
    expect(second.key).toBe(first.key);
  });

  it('key-file fallback: file is created with owner-only (0600) permissions on POSIX', () => {
    if (process.platform === 'win32') {
      // Windows has no POSIX permission bits — chmod is best-effort there
      // (see keystore.ts comment). Nothing meaningful to assert.
      return;
    }
    __setEntryCtorForTests(class {
      constructor(_service: string, _account: string) {
        throw new Error('simulated credential-store outage');
      }
      getPassword(): string | null { throw new Error('unreachable'); }
      setPassword(_p: string): void { throw new Error('unreachable'); }
    } as unknown as typeof Entry);

    const configDir = mkTmpDir('astramem-enc-keyfile-perms-');
    getOrCreateKey(configDir);
    const path = keyFilePath(configDir);
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('credential-store path: getOrCreateKey resolves via a stubbed Entry (idempotent) — exercises the real code path without touching the OS keychain', () => {
    const store = new Map<string, string>();
    __setEntryCtorForTests(class {
      private key: string;
      constructor(service: string, account: string) {
        this.key = `${service}:${account}`;
      }
      getPassword(): string | null {
        return store.get(this.key) ?? null;
      }
      setPassword(p: string): void {
        store.set(this.key, p);
      }
      deleteCredential(): boolean {
        return store.delete(this.key);
      }
      deletePassword(): boolean {
        return store.delete(this.key);
      }
    } as unknown as typeof Entry);

    const configDir = mkTmpDir('astramem-enc-credstore-'); // unused by this path, but getOrCreateKey still takes it
    const first = getOrCreateKey(configDir);
    expect(first.source).toBe('credential-store');
    expect(first.key).toMatch(/^[0-9a-f]{64}$/);

    const second = getOrCreateKey(configDir);
    expect(second.source).toBe('credential-store');
    expect(second.key).toBe(first.key);

    // No key-file should have been written on the credential-store path.
    expect(existsSync(keyFilePath(configDir))).toBe(false);
  });

  it('real @napi-rs/keyring binding round-trips on this OS (smoke test, unique test-only identity — never touches the production astramem-local/db-key entry)', () => {
    const entry = new Entry('astramem-local-test-keystore-smoke', `pid-${process.pid}`);
    try {
      entry.setPassword('smoke-test-value');
      expect(entry.getPassword()).toBe('smoke-test-value');
    } finally {
      entry.deletePassword();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-6 (SEC-9): encryption disabled -> plaintext
// ─────────────────────────────────────────────────────────────────────────

describe('AC-6: security.encryption.enabled=false keeps the DB plaintext', () => {
  it('openDb without a key produces a plaintext-header file', () => {
    const dir = mkTmpDir('astramem-enc-off-');
    const dbPath = join(dir, 'memory.sqlite');

    // Mirrors serve.ts's disabled-encryption branch: openDb(dbPath) with no
    // key opts at all.
    const db = openDb(dbPath);
    migrate(db);
    db.close();

    expect(fileHeader(dbPath)).toBe(PLAINTEXT_MAGIC);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// SEC-8: backup of an encrypted DB stays encrypted
// ─────────────────────────────────────────────────────────────────────────

describe('SEC-8: backup output of an encrypted DB is not plaintext', () => {
  it('createSnapshot() on an encrypted DB writes an encrypted backup file', async () => {
    const dir = mkTmpDir('astramem-enc-backup-');
    const dbPath = join(dir, 'memory.sqlite');
    const key = randomBytes(32).toString('hex');

    const db = openDb(dbPath, { key });
    migrate(db);
    const repo = new MemoryRepo(db);
    makeMemory(repo, 'backup-hash-1');

    const outPath = join(dir, 'backups', 'memory-snapshot.sqlite');
    const result = await createSnapshot(db, outPath);
    db.close();

    expect(existsSync(result.path)).toBe(true);
    expect(fileHeader(result.path)).not.toBe(PLAINTEXT_MAGIC);

    // And the backup is genuinely readable with the same key.
    const restored = openDb(result.path, { key });
    const count = (restored.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    expect(count).toBe(1);
    restored.close();
  });
});
