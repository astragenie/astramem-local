/**
 * tests/cli/sync.test.ts — regression coverage for the sync-teardown
 * assertion (worktree laneC-sync-teardown / fix/sync-teardown-assertion).
 *
 * Repro (proven live this session): `astramem-local sync pull` against a
 * server returning HTTP 500 threw the HTTP error out of `syncCommand` AND
 * crashed the process with a native libuv assertion on Windows:
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *
 * Root cause: `syncCommand`'s 'pull' (and 'backfill'/'watermark') branches
 * opened the runtime DB via `openRuntimeDb()` but never closed it. On the
 * error path the rejection propagated uncaught to `main()`'s top-level
 * `.catch(e => { console.error(e); process.exit(1); })` — a hard
 * `process.exit()` while the better-sqlite3 handle was still open raced the
 * handle's own native teardown, producing the assertion.
 *
 * Fix: every branch that opens the DB now closes it exactly once in a
 * `finally`, on both the success and the throw path, before the rejection
 * can ever reach that outer `process.exit()`.
 *
 * These tests can't reproduce the native crash itself (that requires an
 * actual forced-exit process under Windows' libuv build), but they prove
 * the mechanism that caused it is closed: after a failing (and a
 * succeeding) `sync pull`, the sqlite file handle is fully released — proven
 * by renaming the file out from under the process, which fails on Windows
 * if ANY handle to it is still open.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { rmSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeSyncSettings } from '../../src/config/sync-settings.js';
import { defaultConfigDir } from '../../src/config/datadir.js';
import { syncCommand } from '../../src/cli/sync.js';

function mkTmp(): string {
  const dir = join(tmpdir(), `astra-sync-cli-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeFetch(status: number, bodyJson: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(bodyJson), { status })) as unknown as typeof fetch;
}

// Config-dir isolation MUST cover every platform, not just Windows.
// defaultConfigDir() only honors APPDATA on win32; on Linux it reads
// $XDG_CONFIG_HOME (fallback ~/.config) and on macOS ~/Library — so an
// APPDATA-only override leaks the CI runner's REAL ~/.config/astra-memory/
// sync.json into the test (a paired runner makes cfg.sync.url non-empty,
// so the "incomplete config" case below instead reaches a live fetch and
// dies with "fetch failed"). Override HOME + both XDG roots too so the
// config/data dirs resolve strictly under our temp dirs on all platforms.
const ENV_KEYS = ['APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'HOME', 'ASTRA_MEMORY_DATADIR', 'ASTRA_SYNC_TOKEN'] as const;
type EnvKey = (typeof ENV_KEYS)[number];

/** Point every platform's config + data dir at temp roots under our control. */
function isolateDirs(configRoot: string, dataRoot: string): void {
  process.env.APPDATA = configRoot; // win32 config
  process.env.LOCALAPPDATA = dataRoot; // win32 data
  process.env.XDG_CONFIG_HOME = configRoot; // linux config
  process.env.XDG_DATA_HOME = dataRoot; // linux data
  process.env.HOME = configRoot; // macOS config (~/Library) + linux fallback
  process.env.ASTRA_MEMORY_DATADIR = dataRoot; // DB path (openRuntimeDb)
}

describe('syncCommand pull — DB teardown on both the error and success path (sync-teardown assertion)', () => {
  const saved: Partial<Record<EnvKey, string | undefined>> = {};
  const dirs: string[] = [];

  function setupEnv(): { configDir: string; dataDir: string; dbPath: string } {
    const appDataRoot = mkTmp();
    const dataDir = mkTmp();
    dirs.push(appDataRoot, dataDir);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    isolateDirs(appDataRoot, dataDir);
    process.env.ASTRA_SYNC_TOKEN = 'test-device-token';
    // resolveRuntimeConfig reads sync.json from defaultConfigDir(), now pinned
    // under appDataRoot on every platform (see isolateDirs) — NOT the root itself.
    const configDir = defaultConfigDir();
    writeSyncSettings(configDir, { enabled: true, url: 'https://cloud.example', workspaceId: 'w-1', tenantId: 't-1' });
    return { configDir, dataDir, dbPath: join(dataDir, 'memory.sqlite') };
  }

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('a fetcher HTTP error propagates AND fully releases the DB handle (no leaked handle on the error path)', async () => {
    const { dbPath } = setupEnv();
    vi.stubGlobal('fetch', fakeFetch(500, { error: 'internal' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(syncCommand(['pull'])).rejects.toThrow(/sync pull failed: HTTP 500/);

    // The daemon opens memory.sqlite lazily on first write via migrate() —
    // it always exists by the time openRuntimeDb() returns.
    expect(existsSync(dbPath)).toBe(true);

    // Proves the DB handle was actually closed: on Windows, renaming a file
    // with any open handle throws EPERM/EBUSY. A leaked better-sqlite3
    // handle here is exactly the class of bug that raced process.exit() and
    // produced the native UV_HANDLE_CLOSING assertion.
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();

    errSpy.mockRestore();
  });

  it('a successful pull also releases the DB handle (no regression on the happy path)', async () => {
    const { dbPath } = setupEnv();
    vi.stubGlobal('fetch', fakeFetch(200, { events: [], next_cursor: null }));
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(syncCommand(['pull'])).resolves.toBeUndefined();

    expect(existsSync(dbPath)).toBe(true);
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
  });

  it('incomplete sync config exits non-zero (via exitCode, not a hard process.exit) and still releases the DB handle', async () => {
    // Deliberately skip writeSyncSettings so cfg.sync.url stays '' (default,
    // no pairing) — hits the same early-exit branch as a missing device
    // token, without needing a real OS keystore round trip (ASTRA_SYNC_TOKEN
    // stays set here so `?? readSyncToken()` never evaluates its RHS).
    const appDataRoot = mkTmp();
    const dataDir = mkTmp();
    dirs.push(appDataRoot, dataDir);
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    isolateDirs(appDataRoot, dataDir);
    process.env.ASTRA_SYNC_TOKEN = 'test-device-token';
    const dbPath = join(dataDir, 'memory.sqlite');

    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const savedExitCode = process.exitCode;

    await expect(syncCommand(['pull'])).resolves.toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = savedExitCode;

    expect(existsSync(dbPath)).toBe(true);
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
  });

  it('watermark also releases the DB handle', async () => {
    const { dbPath } = setupEnv();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(syncCommand(['watermark'])).resolves.toBeUndefined();

    expect(existsSync(dbPath)).toBe(true);
    expect(() => renameSync(dbPath, `${dbPath}.moved`)).not.toThrow();
  });
});
