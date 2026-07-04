/**
 * tests/smoke/encrypted-restart.test.ts — FEAT-415: smoke coverage for the
 * encrypted-DB restart path.
 *
 * SLICE-SMOKE-1 (tests/smoke/smoke.test.ts) explicitly ran with
 * security.encryption.enabled:false (accepted F1 tradeoff) to avoid a
 * spawned daemon touching the real OS credential store. Since encryption is
 * the PRODUCTION default (src/config/config.ts defaultConfig()), that left
 * the encrypted reopen path (better-sqlite3-multiple-ciphers + keystore
 * fallback) with zero automated restart coverage.
 *
 * Seam (see .claude/artifacts/crew/runs/FEAT-415-premortem.md for the full
 * writeup): ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 makes getOrCreateKey()
 * (src/storage/keystore.ts) skip the OS credential-store attempt entirely
 * and go straight to the key-file fallback (`<configDir>/db.key`). This is
 * necessary — not just convenient — because the daemon under test is a
 * separate child process; the existing in-process __setEntryCtorForTests
 * stub used by tests/security/encryption.test.ts has no effect across a
 * process boundary, and Entry(service, account) is keyed globally by the OS
 * credential store, not namespaced by the sandboxed APPDATA/HOME env
 * overrides makeIsolatedDaemonEnv already applies.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir, defaultDataDir } from '../../src/config/datadir.js';
import { getOrCreateKey, __setEntryCtorForTests, keyFilePath } from '../../src/storage/keystore.js';
import type { Entry } from '@napi-rs/keyring';
import {
  spawnDaemon, killDaemon, waitForHealthOk, pollSearchHits, pollUntil,
  makeIsolatedDaemonEnv, cleanupIsolatedDaemonEnv,
  type DaemonHandle, type IsolatedDaemonEnv, type SearchHit,
} from './helpers/daemon.js';

const PORT = 19200; // unique — 19000 is smoke.test.ts's port
const TOKEN = 'smoke-enc-tok-1';
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AUTH = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } as const;

const PLAINTEXT_MAGIC = 'SQLite format 3\0';

const FIXTURE_PATH = join(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '_fixtures',
  'session-canonical.json',
);
const FIXTURE = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as {
  captured_at: string;
  project_id: string;
};

function fileHeader(path: string): string {
  return readFileSync(path).subarray(0, 16).toString('latin1');
}

function snapshotDir(dir: string): string[] | null {
  if (!existsSync(dir)) return null;
  return [...readdirSync(dir)].sort();
}

// Real (unmodified) OS dirs — never touched by the sandboxed spawn below.
const REAL_CONFIG_DIR = defaultConfigDir();
const REAL_DATA_DIR = defaultDataDir();
const realDirsBefore = { config: snapshotDir(REAL_CONFIG_DIR), data: snapshotDir(REAL_DATA_DIR) };

// ─────────────────────────────────────────────────────────────────────────
// AC-4 (unit-level, no daemon spawn): production default (flag unset) still
// routes through the credential-store attempt first — the seam added for
// this FEAT does not change behavior outside tests. Exercised in-process
// against a STUBBED Entry (never the real OS credential store) so this
// assertion itself stays safe to run anywhere.
// ─────────────────────────────────────────────────────────────────────────

describe('AC-4: ASTRA_MEMORY_TEST_FORCE_KEYFILE is off by default — production path unchanged', () => {
  const tmpDirs: string[] = [];

  afterAll(() => {
    __setEntryCtorForTests(undefined);
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  function mkTmpConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'astramem-enc-restart-unit-'));
    tmpDirs.push(dir);
    return dir;
  }

  it('with the flag unset, getOrCreateKey still attempts the credential store first', () => {
    expect(process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE).toBeUndefined();

    let constructed = false;
    __setEntryCtorForTests(class {
      constructor(_service: string, _account: string) {
        constructed = true;
      }
      getPassword(): string | null { return null; }
      setPassword(_p: string): void { /* no-op */ }
      deleteCredential(): boolean { return false; }
      deletePassword(): boolean { return false; }
    } as unknown as typeof Entry);

    const result = getOrCreateKey('C:/unused-configdir-credential-store-path');
    expect(constructed, 'credential-store Entry constructor must be attempted when the seam flag is unset').toBe(true);
    expect(result.source).toBe('credential-store');
  });

  it('with the flag set to "1", getOrCreateKey bypasses the credential store entirely (never constructs Entry)', () => {
    let constructed = false;
    __setEntryCtorForTests(class {
      constructor(_service: string, _account: string) {
        constructed = true;
        throw new Error('must never be reached when ASTRA_MEMORY_TEST_FORCE_KEYFILE=1');
      }
      getPassword(): string | null { throw new Error('unreachable'); }
      setPassword(_p: string): void { throw new Error('unreachable'); }
    } as unknown as typeof Entry);

    const dir = mkTmpConfigDir();
    process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE = '1';
    try {
      const result = getOrCreateKey(dir);
      expect(constructed, 'credential-store Entry constructor must NOT be constructed when the seam flag is "1"').toBe(false);
      expect(result.source).toBe('key-file');
      expect(existsSync(keyFilePath(dir))).toBe(true);
    } finally {
      delete process.env.ASTRA_MEMORY_TEST_FORCE_KEYFILE;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// AC-1/2/3: full spawned-daemon restart suite against a REAL encrypted file
// datadir.
// ─────────────────────────────────────────────────────────────────────────

let isolated: IsolatedDaemonEnv;
let daemon: DaemonHandle | null = null;
let dbPath: string;
let beforeIds: string[];

describe.sequential('Encrypted-DB restart suite (FEAT-415)', () => {
  beforeAll(() => {
    isolated = makeIsolatedDaemonEnv('astramem-enc-restart', { encryption: true });
    dbPath = join(isolated.dataDir, 'memory.sqlite');
  });

  afterAll(async () => {
    if (daemon) await killDaemon(daemon, 'SIGKILL', 5_000);
    cleanupIsolatedDaemonEnv(isolated);
  });

  it('step 0: sandbox has encryption ENABLED (at the path the daemon actually reads) and the test-only key-file-force flag set', () => {
    // effectiveConfigDir, not configDir — see helpers/daemon.ts's FEAT-415
    // doc comment: defaultConfigDir() joins a platform subdir onto
    // APPDATA/HOME/XDG_CONFIG_HOME, so this is the path the spawned daemon
    // actually resolves and reads config.yaml from.
    const cfgText = readFileSync(join(isolated.effectiveConfigDir, 'config.yaml'), 'utf8');
    expect(cfgText).toContain('enabled: true');
    expect(isolated.env['ASTRA_MEMORY_TEST_FORCE_KEYFILE']).toBe('1');
    expect(isolated.configDir).not.toBe(REAL_CONFIG_DIR);
    expect(isolated.effectiveConfigDir).not.toBe(REAL_CONFIG_DIR);
    expect(isolated.dataDir).not.toBe(REAL_DATA_DIR);
  });

  it('step 1: daemon spawns, ingests, and distills into a searchable memory against an ENCRYPTED datadir (AC-1 setup)', async () => {
    daemon = spawnDaemon({ port: PORT, token: TOKEN, env: isolated.env });
    daemon.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[enc-smoke-daemon] ${chunk.toString()}`);
    });

    await waitForHealthOk(BASE_URL);
    expect(daemon.exitInfo().code, `daemon exited early — stderr:\n${daemon.stderr()}`).toBeNull();

    const res = await fetch(`${BASE_URL}/ingest/transcript`, {
      method: 'POST',
      headers: { ...AUTH, 'idempotency-key': 'enc-smoke-ingest-1' },
      body: JSON.stringify(FIXTURE),
    });
    const body = (await res.json()) as { ok: boolean };
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.ok).toBe(true);

    await pollSearchHits(
      BASE_URL, TOKEN, 'sqlite',
      hits => hits.filter(h => h.type === 'decision' && h.text.toLowerCase().includes('sqlite-vec')),
      { label: 'distill worker to drain the transcript into a decision memory mentioning sqlite-vec' },
    );
  }, 40_000);

  it('step 2: on-disk file is genuinely encrypted (header != plaintext magic) — the test-only seam never left the DB unencrypted', () => {
    expect(existsSync(dbPath)).toBe(true);
    expect(fileHeader(dbPath)).not.toBe(PLAINTEXT_MAGIC);
  });

  it('step 3: key resolved via the key-file fallback, never the real OS credential store (AC-2)', () => {
    const keyPath = keyFilePath(isolated.effectiveConfigDir);
    expect(existsSync(keyPath), 'ASTRA_MEMORY_TEST_FORCE_KEYFILE=1 must produce a key file under the sandboxed configDir').toBe(true);
    const key = readFileSync(keyPath, 'utf8').trim();
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // Real OS dirs untouched so far — the strongest available proxy (short of
    // reading the Windows Credential Manager directly) that this run never
    // reached the real credential store: it never even touched the real
    // APPDATA/LOCALAPPDATA dirs the credential-store path has no reason to
    // touch either, but this at least proves the sandbox held.
    const realDirsNow = { config: snapshotDir(REAL_CONFIG_DIR), data: snapshotDir(REAL_DATA_DIR) };
    expect(realDirsNow).toEqual(realDirsBefore);
  });

  it('step 4: SIGKILL + respawn against the SAME encrypted datadir — identical memory ids/counts (AC-1)', async () => {
    const before = await fetch(`${BASE_URL}/search?q=sqlite&limit=20`, { headers: AUTH });
    beforeIds = ((await before.json()) as { hits: SearchHit[] }).hits.map(h => h.id).sort();
    expect(beforeIds.length).toBeGreaterThan(0);

    await killDaemon(daemon!, 'SIGKILL', 5_000);
    expect(daemon!.exitInfo().signal, 'daemon should have been force-killed').toBe('SIGKILL');

    daemon = spawnDaemon({ port: PORT, token: TOKEN, env: isolated.env });
    daemon.proc.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(`[enc-smoke-daemon-respawn] ${chunk.toString()}`);
    });
    await waitForHealthOk(BASE_URL);
    expect(daemon.exitInfo().code, `respawned daemon exited early — stderr:\n${daemon.stderr()}`).toBeNull();

    const after = await fetch(`${BASE_URL}/search?q=sqlite&limit=20`, { headers: AUTH });
    const afterIds = ((await after.json()) as { hits: SearchHit[] }).hits.map(h => h.id).sort();
    expect(afterIds).toEqual(beforeIds);
  }, 30_000);

  it('step 5: WRONG key on restart fails LOUD with an actionable error, not silent data loss or a generic crash (AC-3)', async () => {
    await killDaemon(daemon!, 'SIGKILL', 5_000);
    daemon = null;

    const keyPath = keyFilePath(isolated.effectiveConfigDir);
    const originalKey = readFileSync(keyPath, 'utf8').trim();
    const wrongKey = randomBytes(32).toString('hex');
    expect(wrongKey).not.toBe(originalKey);
    writeFileSync(keyPath, wrongKey, 'utf8');

    const wrongKeyDaemon = spawnDaemon({ port: PORT, token: TOKEN, env: isolated.env });
    try {
      await pollUntil(
        async () => wrongKeyDaemon.exitInfo(),
        info => info.code !== null || info.signal !== null,
        { label: 'daemon to exit after being handed the wrong encryption key', timeoutMs: 15_000, intervalMs: 200 },
      );
      const exitInfo = wrongKeyDaemon.exitInfo();
      expect(exitInfo.code, 'wrong-key daemon must exit non-zero, not silently serve stale/empty data').not.toBe(0);

      const stderr = wrongKeyDaemon.stderr();
      expect(stderr).toContain('does not match this file');
      expect(stderr).toMatch(/wrong or stale key/i);
      expect(stderr.toLowerCase()).toContain('key file');
      // Must NOT read as the unrelated plaintext-vs-cipher-build shadowing
      // issue documented in CLAUDE.md — the message must be specific enough
      // to distinguish the two failure classes.
      expect(stderr).toContain('NOT a plaintext-vs-cipher-build issue');
    } finally {
      // Restore the correct key so teardown's health/port checks and any
      // later run against this dir are not left in a broken state.
      writeFileSync(keyPath, originalKey, 'utf8');
      if (wrongKeyDaemon.exitInfo().code === null && wrongKeyDaemon.exitInfo().signal === null) {
        await killDaemon(wrongKeyDaemon, 'SIGKILL', 5_000);
      }
    }
  }, 20_000);

  it('step 6: teardown — remove temp dirs, verify port free, real OS dirs untouched', async () => {
    await expect(fetch(`${BASE_URL}/health`, { signal: AbortSignal.timeout(1_000) })).rejects.toBeTruthy();

    cleanupIsolatedDaemonEnv(isolated);
    expect(existsSync(isolated.root)).toBe(false);

    const realDirsAfter = { config: snapshotDir(REAL_CONFIG_DIR), data: snapshotDir(REAL_DATA_DIR) };
    expect(realDirsAfter).toEqual(realDirsBefore);
  }, 15_000);
});
