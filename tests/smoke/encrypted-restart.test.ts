/**
 * FEAT-415 — encrypted-DB restart smoke coverage.
 *
 * tests/smoke/smoke.test.ts's step 5 already proves SIGKILL + respawn against
 * the SAME datadir, but its isolated sandbox runs with
 * `security.encryption.enabled: false` (see that file's step 0 assertion), so
 * it never exercises the SQLCipher-encrypted open/reopen path at all — the
 * exact class of bug a stale-global `SQLITE_NOTADB` trap belongs to (a
 * daemon that opens an encrypted memory.sqlite without the right key, or
 * with no key at all, throws `SQLITE_NOTADB` from better-sqlite3-multiple-
 * ciphers). This suite spawns a daemon with encryption ENABLED against a
 * real file datadir, ingests a fixture, kills it with SIGKILL, and respawns
 * against the SAME encrypted datadir — proving the second boot re-derives
 * the identical key and decrypts the existing file cleanly.
 *
 * Isolation note (see helpers/daemon.ts:makeIsolatedDaemonEnv's `encrypted`
 * option): `security.encryption.enabled: true` makes serve.ts call
 * getOrCreateKey(), which tries the REAL OS credential store first (fixed
 * identity service='astramem-local', account='db-key' — the SAME identity a
 * real production install uses). To keep this sandbox from touching that
 * real OS resource, `encrypted: true` also installs a NODE_OPTIONS `--import`
 * hook that makes the credential-store binding always throw, deterministically
 * forcing the documented key-file fallback (`<configDir>/db.key`) instead.
 * The encryption itself is 100% real SQLCipher — only the key SOURCE is
 * faked away from the OS keychain.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { readLockInfo } from '../../src/service/instance-lock.js';
import { defaultConfigDir, defaultDataDir } from '../../src/config/datadir.js';
import {
  spawnDaemon, killDaemon, waitForHealthOk, pollSearchHits,
  makeIsolatedDaemonEnv, cleanupIsolatedDaemonEnv,
  type DaemonHandle, type IsolatedDaemonEnv, type SearchHit,
} from './helpers/daemon.js';

// ── Config ───────────────────────────────────────────────────────────────────

// devops#69: PORT/BASE_URL start as placeholders and are overwritten with the
// REAL OS-assigned ephemeral port once step 1 spawns the daemon with
// `port: 0` — a fixed port collides with the shared runner VM's persistent
// TEI container on :8080 and with neighbor CI jobs' own spawned daemons.
// `let` (not `const`) because later steps' closures read the updated value —
// describe.sequential guarantees step 1 has already run by then.
let PORT = 0;
let BASE_URL = '';
// Unique per test run (not just per file) so an accidental cross-connect
// across concurrent jobs on the shared runner fails closed (401) instead of
// silently succeeding against a neighbor's daemon that happens to share a
// hardcoded literal token.
const TOKEN = `smoke-enc-tok-${randomUUID()}`;
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '_fixtures',
  'session-canonical.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  captured_at: string;
  project_id: string;
  agent_type: string;
};

const PLAINTEXT_MAGIC = 'SQLite format 3\0';

function dbHeader(path: string): string {
  return readFileSync(path).subarray(0, 16).toString('latin1');
}

// Real (unmodified) OS dirs, resolved in THIS process — must stay untouched,
// same non-flaky name-set-only comparison approach as smoke.test.ts (a real
// concurrently-running production daemon on this host legitimately rewrites
// its own files on its own schedule).
const REAL_CONFIG_DIR = defaultConfigDir();
const REAL_DATA_DIR = defaultDataDir();

/** Sorted filename listing (null if absent) — same name-set-only comparison
 *  as smoke.test.ts's snapshotDir, deliberately not mtimes/content (a real
 *  concurrently-running production daemon on this host legitimately
 *  rewrites its own files on its own schedule). */
function snapshotDir(dir: string): string[] | null {
  if (!existsSync(dir)) return null;
  return [...readdirSync(dir)].sort();
}

const realDirsBefore = { config: snapshotDir(REAL_CONFIG_DIR), data: snapshotDir(REAL_DATA_DIR) };

let isolated: IsolatedDaemonEnv;
let daemon: DaemonHandle | null = null;
let firstMemoryId: string;
let dbPath: string;

describe.sequential('Encrypted-DB restart smoke suite (FEAT-415)', () => {
  beforeAll(() => {
    isolated = makeIsolatedDaemonEnv('astramem-smoke-enc', { encrypted: true });
    dbPath = join(isolated.dataDir, 'memory.sqlite');
  });

  afterAll(async () => {
    // Defensive backstop: holds even if a step above threw before its own
    // cleanup ran.
    if (daemon) await killDaemon(daemon, 'SIGKILL', 5_000);
    cleanupIsolatedDaemonEnv(isolated);
  });

  it('step 0: isolated sandbox created — encryption ENABLED in config.yaml, no real OS dirs aliased', () => {
    expect(existsSync(isolated.configDir)).toBe(true);
    expect(existsSync(isolated.dataDir)).toBe(true);
    const cfgText = readFileSync(join(isolated.configDir, 'config.yaml'), 'utf8');
    expect(cfgText).toContain('enabled: true');

    expect(isolated.configDir).not.toBe(REAL_CONFIG_DIR);
    expect(isolated.dataDir).not.toBe(REAL_DATA_DIR);

    // The encrypted-restart env carries the fake-keyring NODE_OPTIONS hook —
    // this is the mechanism that keeps the real OS credential store
    // untouched (see helpers/fake-keyring-register.mjs).
    expect(isolated.env['NODE_OPTIONS']).toContain('fake-keyring-register.mjs');
  });

  it('step 1: daemon spawns with encryption enabled and GET /health reports "ok"', async () => {
    daemon = await spawnDaemon({ port: 0, token: TOKEN, env: isolated.env });
    PORT = daemon.port;
    BASE_URL = daemon.baseUrl;
    daemon.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[enc-smoke-daemon] ${chunk.toString()}`);
    });

    await waitForHealthOk(BASE_URL);
    expect(daemon.exitInfo().code, `daemon exited early — stderr:\n${daemon.stderr()}`).toBeNull();

    // Boot must NOT have fallen back to the real OS credential store: the
    // fake-keyring hook forces getOrCreateKey() down the key-file path, so a
    // db.key file must now exist under the isolated configDir (never the
    // real one — REAL_CONFIG_DIR was asserted distinct above).
    const keyFilePath = join(isolated.configDir, 'db.key');
    expect(existsSync(keyFilePath), `expected key-file fallback at ${keyFilePath} — stderr:\n${daemon.stderr()}`).toBe(true);

    // The daemon's stderr must show the credential-store WARNING (proves the
    // fake-keyring throw actually fired, not that encryption silently no-op'd).
    expect(daemon.stderr()).toContain('WARNING: OS credential store unavailable');
  }, 20_000);

  it('step 2: canonical ingest returns 200, distill drains to a searchable memory, and the on-disk file is genuinely encrypted (not plaintext SQLite)', async () => {
    const res = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers: { ...AUTH, 'idempotency-key': 'smoke-enc-ingest-1' },
      body: JSON.stringify(FIXTURE),
    });
    const body = (await res.json()) as { ok: boolean; summary_memory_id: string; session_id: string };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.session_id).toBe('smoke-session-canonical-1');

    const hits = await pollSearchHits(
      BASE_URL,
      TOKEN,
      'sqlite',
      allHits => allHits.filter(h => h.type === 'decision' && h.text.toLowerCase().includes('sqlite-vec')),
      { label: 'distill worker to drain the transcript into a decision memory mentioning sqlite-vec' },
    );
    expect(hits.length).toBeGreaterThan(0);
    firstMemoryId = hits[0]!.id;

    // Real at-rest encryption evidence (mirrors tests/security/encryption.test.ts
    // AC-1): the file header must NOT be the plaintext SQLite magic. This is
    // the actual proof the "encrypted restart" path is being exercised, not
    // just a config flag that got ignored.
    expect(existsSync(dbPath)).toBe(true);
    expect(dbHeader(dbPath)).not.toBe(PLAINTEXT_MAGIC);
  }, 40_000);

  it('step 3: SIGKILL + respawn against the SAME encrypted datadir — no SQLITE_NOTADB, data decrypts intact, daemon.lock PID changed (AC-5/AC-9 for the encrypted path)', async () => {
    const priorLock = readLockInfo(isolated.dataDir);
    expect(priorLock).not.toBeNull();
    const priorPid = priorLock!.pid;
    expect(priorPid).toBe(daemon!.proc.pid);

    const before = await fetch(`${BASE_URL}/search?q=sqlite&limit=20`, { headers: AUTH });
    const beforeIds = ((await before.json()) as { hits: SearchHit[] }).hits.map(h => h.id).sort();
    expect(beforeIds).toContain(firstMemoryId);

    // No graceful shutdown — exercises stale-lock steal + WAL recovery on the
    // next boot against the encrypted file, not the clean SIGTERM path.
    await killDaemon(daemon!, 'SIGKILL', 5_000);
    expect(daemon!.exitInfo().signal, 'daemon should have been force-killed').toBe('SIGKILL');

    daemon = await spawnDaemon({ port: 0, token: TOKEN, env: isolated.env });
    PORT = daemon.port;
    BASE_URL = daemon.baseUrl;
    daemon.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[enc-smoke-daemon-respawn] ${chunk.toString()}`);
    });
    await waitForHealthOk(BASE_URL);

    // The critical assertion this whole suite exists for: the respawned
    // daemon must boot clean against the SAME encrypted file — no
    // SQLITE_NOTADB (wrong/absent key against an encrypted file) and no
    // early exit at all.
    const exitInfo = daemon.exitInfo();
    expect(
      exitInfo.code,
      `respawned daemon exited early (code=${exitInfo.code}, signal=${exitInfo.signal}) against the encrypted datadir — stderr:\n${daemon.stderr()}`,
    ).toBeNull();
    expect(daemon.stderr()).not.toContain('SQLITE_NOTADB');

    // Same real SQLCipher key re-derived from the SAME db.key file — same
    // memory still searchable, decrypted intact.
    const after = await fetch(`${BASE_URL}/search?q=sqlite&limit=20`, { headers: AUTH });
    const afterIds = ((await after.json()) as { hits: SearchHit[] }).hits.map(h => h.id).sort();
    expect(afterIds).toEqual(beforeIds);

    // Still genuinely encrypted on disk (not silently downgraded to
    // plaintext by the second boot).
    expect(dbHeader(dbPath)).not.toBe(PLAINTEXT_MAGIC);

    const newLock = readLockInfo(isolated.dataDir);
    expect(newLock).not.toBeNull();
    expect(newLock!.pid).toBe(daemon.proc.pid);
    expect(newLock!.pid).not.toBe(priorPid);
  }, 30_000);

  it('step 4: teardown — kill daemon, remove temp dirs, real OS dirs untouched', async () => {
    await killDaemon(daemon!, 'SIGTERM', 5_000);
    const exitInfo = daemon!.exitInfo();
    expect(exitInfo.code === 0 || exitInfo.signal !== null).toBe(true);
    daemon = null; // afterAll's backstop becomes a no-op

    await expect(fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toBeTruthy();

    cleanupIsolatedDaemonEnv(isolated);
    expect(existsSync(isolated.root)).toBe(false);

    // Real %APPDATA%\Astramem / %LOCALAPPDATA%\Astramem (or non-Windows
    // equivalents) must be byte-for-byte untouched — same file-set diff as
    // smoke.test.ts's step 6 (this ALSO proves the fake-keyring hook did its
    // job: no real credential-store WRITE means no incidental filesystem
    // side effect near these dirs either, though the credential store isn't
    // filesystem-visible here — this assertion covers the dir-redirection
    // half of isolation; the credential-store half is covered by step 1's
    // "WARNING: OS credential store unavailable" + db.key-exists assertions).
    const realDirsAfter = { config: snapshotDir(REAL_CONFIG_DIR), data: snapshotDir(REAL_DATA_DIR) };
    expect(realDirsAfter).toEqual(realDirsBefore);
  }, 15_000);
});
