/**
 * tests/cli/serve-boot-single-open.test.ts
 *
 * Wave 7 boot-fix investigation (2026-07-23): the working theory was that
 * serve.ts's boot sequence opens the SQLite DB more than once before binding
 * the port (e.g. once for migrate(), again for the serving repos), roughly
 * doubling the pre-bind window on a large encrypted DB and feeding the
 * daemon-boot-crashloop symptom (see docs/memory.md / CLAUDE.md). Tracing
 * every function reachable before `app.listen()` in both the default
 * (bind-before-migrate, FEAT-537) and `--strict-preflight`
 * (migrate-before-bind) branches found exactly ONE `openDb()` call either
 * way — `migrate()` takes an already-open `DB` handle and never opens its
 * own connection (src/storage/migrate.ts has no `openDb`/`Database` import at
 * all), and every post-bind consumer (JobRepo, MemoryRepo, SqliteVecStore,
 * the worker's ExtendedHandlerCtx, the health-snapshot refresher,
 * CachingEmbedProvider) reuses the SAME handle. The theory did not hold for
 * the current code; this test locks the actually-true invariant in place so
 * a future change (e.g. giving migrate() its own connection) can't silently
 * reintroduce a second physical open on the pre-bind path without a test
 * failing.
 *
 * `openBootDb` was extracted out of `bootAndBind`'s inline if/else-if/else
 * specifically so this is testable at all: `serve()` itself registers
 * SIGTERM/SIGINT handlers that end in `process.exit(0)` (see serve.ts's
 * `shutdown`), so driving the full function in-process would kill the
 * vitest worker — the same reasoning tests/doctor/schedule.test.ts's doc
 * comment gives for why it drives doctor/schedule.ts directly instead of
 * `serve()`. `openBootDb` has no signal handlers and binds nothing; it is
 * safe to call directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as dbModule from '../../src/storage/db.js';
import { openBootDb } from '../../src/cli/serve.js';
import { defaultConfig } from '../../src/config/config.js';

// getOrCreateKey(defaultConfigDir()) is hardcoded to the REAL default config
// dir (src/cli/serve.ts's encrypted branch never accepts an injected
// configDir — same as before this file's refactor) — mocked so this test
// never touches the developer's real %APPDATA%/Astramem credential store.
// encryptIfPlaintext is NOT mocked: every test below uses a fresh temp path
// that doesn't exist yet, so it is already a genuine no-op (`existsSync`
// false -> 'missing', first line of the real function) with no need to fake it.
vi.mock('../../src/storage/keystore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/storage/keystore.js')>();
  return {
    ...actual,
    getOrCreateKey: vi.fn(() => ({ key: 'a'.repeat(64), source: 'key-file' as const })),
  };
});

let tmpDirs: string[] = [];
function mkTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  tmpDirs = [];
});

describe('openBootDb — exactly one physical DB open on the pre-bind path', () => {
  it(':memory: dataDir opens exactly once', () => {
    const spy = vi.spyOn(dbModule, 'openDb');
    const { db, dbKey } = openBootDb(':memory:', ':memory:', defaultConfig());
    expect(spy).toHaveBeenCalledTimes(1);
    expect(dbKey).toBeUndefined();
    db.close();
  });

  it('plaintext (encryption disabled) opens exactly once', () => {
    const dir = mkTmpDir('astra-boot-single-open-plain-');
    const dbPath = join(dir, 'memory.sqlite');
    const spy = vi.spyOn(dbModule, 'openDb');
    const cfg = defaultConfig();
    cfg.security.encryption.enabled = false;
    const { db, dbKey } = openBootDb(dir, dbPath, cfg);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(dbPath);
    expect(dbKey).toBeUndefined();
    db.close();
  });

  it('encrypted (fresh datadir) opens exactly once', () => {
    const dir = mkTmpDir('astra-boot-single-open-enc-');
    const dbPath = join(dir, 'memory.sqlite');
    const spy = vi.spyOn(dbModule, 'openDb');
    const cfg = defaultConfig();
    cfg.security.encryption.enabled = true;
    const { db, dbKey } = openBootDb(dir, dbPath, cfg);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(dbKey).toBe('a'.repeat(64));
    db.close();
  });

  it('encrypted branch still rewraps a wrong-key NOTADB failure (unchanged behavior after extraction)', () => {
    const dir = mkTmpDir('astra-boot-single-open-wrongkey-');
    const dbPath = join(dir, 'memory.sqlite');
    const notADbError = Object.assign(new Error('file is not a database'), { code: 'SQLITE_NOTADB' });
    vi.spyOn(dbModule, 'openDb').mockImplementation(() => { throw notADbError; });
    const cfg = defaultConfig();
    cfg.security.encryption.enabled = true;
    expect(() => openBootDb(dir, dbPath, cfg)).toThrow(/does not match this file/);
  });
});
