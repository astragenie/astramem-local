/**
 * tests/smoke/helpers/daemon.ts — shared daemon spawn/health/poll helpers.
 *
 * Extracted from tests/e2e/plugin-flow.test.ts (which now imports this
 * module too) so the plugin-flow E2E test and the smoke suite share one
 * spawn/poll implementation instead of two copies drifting apart.
 * Parameterized on port/token/env so a caller can run multiple isolated
 * daemons in one test file (the smoke suite's SIGKILL/respawn step spawns a
 * second daemon against the same config+data dirs).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { defaultConfigDir } from '../../../src/config/datadir.js';

/** Repo root, resolved relative to this file — works whether ts-node/vitest
 *  runs it from source or a built copy, and handles the Windows
 *  `/C:/...` → `C:/...` file-URL quirk the same way plugin-flow.test.ts did. */
export const REPO_ROOT = join(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '..', '..', '..',
);

/** Directory this file lives in — used to locate the fake-keyring loader
 *  hook shipped alongside it (see makeIsolatedDaemonEnv's `encrypted` opt). */
const HELPERS_DIR = dirname(fileURLToPath(import.meta.url));

// ── Daemon process lifecycle ────────────────────────────────────────────────

export interface DaemonHandle {
  proc: ChildProcess;
  port: number;
  token: string;
  baseUrl: string;
  /** Accumulated stdout, for diagnostics on a failed poll/assert. */
  stdout(): string;
  /** Accumulated stderr, for diagnostics on a failed poll/assert. */
  stderr(): string;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null };
}

export interface SpawnDaemonOpts {
  /**
   * Port to request. Pass `0` (recommended — see `PORT` below) to let the OS
   * assign an ephemeral port; `spawnDaemon` then parses the REAL bound port
   * back out of the daemon's boot log line and returns it via
   * `DaemonHandle.port`/`baseUrl`. A nonzero value is honored as-is (no
   * ephemeral resolution) for callers with a genuine reason to pin a port.
   */
  port: number;
  token: string;
  /** Extra/overriding env vars merged over process.env (e.g. ASTRA_MEMORY_DATADIR,
   *  ASTRA_MEMORY_MOCK_PROVIDERS, APPDATA/HOME/XDG_CONFIG_HOME overrides). */
  env?: Record<string, string>;
  cwd?: string;
}

/** devops#69: the daemon's serve.ts prints this exact line once it has
 *  bound its listening socket — `<port>` is the REAL bound port, which is
 *  the OS-assigned ephemeral port when spawned with `--port 0`. This is the
 *  only place in the codebase that parses that line; keep in sync with
 *  src/cli/serve.ts's `console.log(\`astramem-local serving on ...\`)` call. */
const SERVING_LINE_RE = /astramem-local serving on [^\s:]+:(\d+)/;

/**
 * Poll the daemon's accumulated stdout for the boot line that announces its
 * REAL bound port (see SERVING_LINE_RE), throwing a diagnostic error if the
 * process exits first or the line never appears within `timeoutMs`.
 *
 * Exported so callers that spawn the daemon themselves instead of going
 * through `spawnDaemon` (e.g. tests/integration/ingest-e2e.test.ts, which
 * manages its own ChildProcess lifecycle) can resolve the real ephemeral
 * port the same way (devops#69).
 */
export async function waitForBoundPort(
  getStdout: () => string,
  getStderr: () => string,
  getExitInfo: () => { code: number | null; signal: NodeJS.Signals | null },
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = SERVING_LINE_RE.exec(getStdout());
    if (match) return Number(match[1]);
    const { code, signal } = getExitInfo();
    if (code !== null || signal !== null) {
      throw new Error(
        `daemon exited before printing its bound port (code=${code} signal=${signal})\n` +
        `stdout:\n${getStdout()}\nstderr:\n${getStderr()}`,
      );
    }
    await sleep(50);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for the daemon to print its bound port\n` +
    `stdout:\n${getStdout()}\nstderr:\n${getStderr()}`,
  );
}

/**
 * Spawn `node dist/cli/index.js serve --port <port>` with the given env.
 *
 * devops#69: on the shared self-hosted runner VM, a FIXED port collides with
 * the host's persistent TEI (text-embeddings-inference) container pinned to
 * :8080, and — more insidiously — with a NEIGHBOR CI job's own spawned
 * daemon on a different, unrelated auth token: a test client that connects
 * to the wrong process on a reused fixed port gets a whole-daemon 401 from a
 * token it never set, while public /health still passes (the fingerprint
 * that misdiagnosed as an auth bug). Requesting port 0 asks the OS for an
 * unused ephemeral port, which is unique per process — no two concurrent
 * jobs (or TEI) can ever collide on it. This function is async because the
 * REAL bound port is only known once the daemon has printed it after
 * `app.listen()` resolves.
 */
export async function spawnDaemon(opts: SpawnDaemonOpts): Promise<DaemonHandle> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const proc = spawn(
    process.execPath,
    ['dist/cli/index.js', 'serve', '--port', String(opts.port)],
    {
      env: {
        ...(process.env as Record<string, string>),
        ASTRA_MEMORY_TOKEN: opts.token,
        ...opts.env,
      },
      cwd: opts.cwd ?? REPO_ROOT,
      stdio: 'pipe',
    },
  );

  proc.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  proc.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  proc.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });

  const actualPort = opts.port === 0
    ? await waitForBoundPort(() => stdout, () => stderr, () => ({ code: exitCode, signal: exitSignal }))
    : opts.port;

  return {
    proc,
    port: actualPort,
    token: opts.token,
    baseUrl: `http://127.0.0.1:${actualPort}`,
    stdout: () => stdout,
    stderr: () => stderr,
    exitInfo: () => ({ code: exitCode, signal: exitSignal }),
  };
}

/**
 * Kill the daemon (default SIGTERM) and wait for it to exit, up to
 * `timeoutMs`. A no-op if the process already exited. Safe to call from a
 * try/finally teardown even on a failure path.
 */
export async function killDaemon(
  handle: DaemonHandle,
  signal: NodeJS.Signals = 'SIGTERM',
  timeoutMs = 5_000,
): Promise<void> {
  const { code, signal: exitSignal } = handle.exitInfo();
  if (handle.proc.killed || code !== null || exitSignal !== null) return;
  try {
    handle.proc.kill(signal);
  } catch {
    return; // already gone
  }
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, timeoutMs);
    handle.proc.on('exit', () => { clearTimeout(t); resolve(); });
  });
}

// ── Generic diagnostic polling ──────────────────────────────────────────────

export interface PollOptions {
  /** Human-readable description of the awaited condition — used in the
   *  timeout error so a CI failure names what it was waiting for. */
  label: string;
  timeoutMs?: number;
  intervalMs?: number;
}

/**
 * Poll `fn` until `predicate(result)` is true, or throw a diagnostic error
 * naming the condition, elapsed time, and the last observed value/error.
 * Every smoke-suite wait (health, distill drain, respawn) goes through this
 * so a CI failure always says what it was waiting for and what it last saw,
 * instead of a bare "timeout" with no context.
 */
export async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  opts: PollOptions,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const intervalMs = opts.intervalMs ?? 300;
  const start = Date.now();
  const deadline = start + timeoutMs;
  let last: T | undefined;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (predicate(last)) return last;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }

  const elapsed = Date.now() - start;
  const lastDesc = lastError
    ? `last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`
    : `last observed value: ${describeValue(last)}`;
  throw new Error(`Timed out after ${elapsed}ms waiting for: ${opts.label}\n${lastDesc}`);
}

function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Wait for GET /health to respond 200, regardless of the `status` field.
 *  Use this (not waitForHealthOk) for live-provider modes where the
 *  degraded-start embed preflight can leave status 'starting' for a while
 *  after the port is already reachable. */
export async function waitForHealthReachable(
  baseUrl: string,
  opts: Partial<PollOptions> = {},
): Promise<void> {
  await pollUntil(
    async () => {
      const res = await fetch(`${baseUrl}/health`);
      return { ok: res.ok, httpStatus: res.status };
    },
    v => v.ok,
    { label: `GET ${baseUrl}/health to respond 200`, timeoutMs: 8_000, ...opts },
  );
}

/** Wait for GET /health to report `status: 'ok'` (mock providers make this
 *  near-instant — embed.ok is set true before app.listen). */
export async function waitForHealthOk(
  baseUrl: string,
  opts: Partial<PollOptions> = {},
): Promise<void> {
  await pollUntil(
    async () => {
      const res = await fetch(`${baseUrl}/health`);
      if (!res.ok) return { httpStatus: res.status, status: undefined as string | undefined };
      const body = (await res.json()) as { status?: string; ok?: boolean };
      return { httpStatus: res.status, status: body.status };
    },
    v => v.status === 'ok',
    { label: `GET ${baseUrl}/health to report status "ok"`, timeoutMs: 15_000, ...opts },
  );
}

// ── Search polling (distill-drain detection) ────────────────────────────────

export interface SearchHit {
  id: string;
  type: string;
  text: string;
  score: number;
  source: string;
}

/**
 * Poll GET /search until at least one hit satisfies `predicate` (default:
 * always true — any hit at all), or throw the standard pollUntil diagnostic.
 * Used to detect when the async distill worker has drained a just-ingested
 * transcript into a searchable memory.
 */
export async function pollSearchHits(
  baseUrl: string,
  token: string,
  query: string,
  predicate: (hits: SearchHit[]) => SearchHit[],
  opts: Partial<PollOptions> = {},
): Promise<SearchHit[]> {
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  return pollUntil(
    async () => {
      const res = await fetch(`${baseUrl}/search?q=${encodeURIComponent(query)}&limit=20`, { headers });
      if (!res.ok) return [] as SearchHit[];
      const body = (await res.json()) as { hits: SearchHit[] };
      return predicate(body.hits);
    },
    matching => matching.length > 0,
    { label: `GET ${baseUrl}/search?q=${query} to return a matching hit`, timeoutMs: 30_000, ...opts },
  );
}

// ── Isolated config/data sandbox (F1 fix) ───────────────────────────────────

export interface IsolatedDaemonEnv {
  root: string;
  configDir: string;
  dataDir: string;
  /** Env vars that redirect EVERY OS-standard config/data dir lookup
   *  (APPDATA, LOCALAPPDATA, HOME, XDG_CONFIG_HOME, XDG_DATA_HOME) into temp
   *  dirs, plus ASTRA_MEMORY_DATADIR + mock providers. Merge into
   *  SpawnDaemonOpts.env.
   *
   *  Why LOCALAPPDATA too: resolveRuntimeConfig() unconditionally calls
   *  migrateLegacyDirsIfPresent() before reading config, which calls
   *  defaultDataDir()/legacyDataDir() — both read LOCALAPPDATA, independent
   *  of the ASTRA_MEMORY_DATADIR override applied later. Without
   *  redirecting LOCALAPPDATA too, a real legacy %LOCALAPPDATA%\AstraMemory
   *  dir on the host machine could get renamed as a side effect of running
   *  this test. Config encryption is disabled via config.yaml (default) so
   *  serve.ts never calls getOrCreateKey() (no OS Credential Manager access
   *  either) — unless `encrypted: true` was requested, see below. */
  env: Record<string, string>;
}

export interface IsolatedDaemonEnvOpts {
  /** When true, config.yaml sets `security.encryption.enabled: true` (the
   *  daemon actually SQLCipher-encrypts memory.sqlite) AND `env` gets a
   *  NODE_OPTIONS `--import` hook (see helpers/fake-keyring-register.mjs)
   *  that makes keystore.ts's `@napi-rs/keyring` Entry constructor always
   *  throw. That deterministically forces getOrCreateKey() down its
   *  documented key-file fallback (a `db.key` file under `configDir`)
   *  instead of the REAL OS credential store (Windows Credential Manager /
   *  macOS Keychain / Linux libsecret) — preserving the same "never touch a
   *  real OS resource" guarantee the base (encryption-disabled) sandbox
   *  already has, while still exercising the genuine SQLCipher-encrypted
   *  open/close/reopen code path end to end. Default false. */
  encrypted?: boolean;
}

/**
 * Temporarily apply `overrides` to `process.env`, run `fn`, then restore the
 * prior values (even keys that were previously unset). Used to compute what
 * defaultConfigDir() resolves to for a GIVEN set of env overrides without
 * duplicating datadir.ts's per-platform branching here — the two must never
 * drift, or config.yaml gets written to a directory the spawned daemon never
 * actually reads (see the historical bug this replaced: config.yaml was
 * written directly under the value assigned to APPDATA, but defaultConfigDir()
 * always appends its own platform-specific leaf — "Astramem" on win32,
 * "astra-memory" under XDG_CONFIG_HOME on Linux — so the file silently landed
 * one directory too shallow and every isolated-sandbox daemon boot fell back
 * to defaultConfig(), i.e. security.encryption.enabled: true, the exact real
 * OS-credential-store contact this sandbox exists to prevent).
 */
function withEnvOverrides<T>(overrides: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/**
 * Create an isolated temp config dir (config.yaml with encryption disabled
 * by default, or enabled via `opts.encrypted`) + temp data dir + a sandboxed
 * "local app data" dir, and return the env overrides that keep a spawned
 * daemon entirely inside them. Never touches the real %APPDATA%\Astramem /
 * %LOCALAPPDATA%\Astramem (or the legacy AstraMemory dirs) on the host, and
 * — with `opts.encrypted: true` — never touches the real OS credential store
 * either (see IsolatedDaemonEnvOpts doc above).
 */
export function makeIsolatedDaemonEnv(prefix: string, opts: IsolatedDaemonEnvOpts = {}): IsolatedDaemonEnv {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const appDataRoot = join(root, 'appdata');
  const dataDir = join(root, 'data');
  const localAppDataRoot = join(root, 'localappdata');
  mkdirSync(appDataRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(localAppDataRoot, { recursive: true });

  const dirEnvOverrides: Record<string, string> = {
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
    HOME: appDataRoot,
    XDG_CONFIG_HOME: appDataRoot,
    XDG_DATA_HOME: localAppDataRoot,
  };

  // The REAL leaf dir the spawned daemon's defaultConfigDir() will resolve
  // to given the above overrides — NOT necessarily `appDataRoot` itself
  // (win32 appends "Astramem"; Linux appends "astra-memory" under
  // XDG_CONFIG_HOME; darwin ignores APPDATA/XDG entirely and derives from
  // HOME). config.yaml must live exactly here or the daemon never reads it.
  const configDir = withEnvOverrides(dirEnvOverrides, defaultConfigDir);
  mkdirSync(configDir, { recursive: true });

  writeFileSync(
    join(configDir, 'config.yaml'),
    `security:\n  encryption:\n    enabled: ${opts.encrypted ? 'true' : 'false'}\n`,
    'utf8',
  );

  const env: Record<string, string> = {
    ...dirEnvOverrides,
    ASTRA_MEMORY_DATADIR: dataDir,
    ASTRA_MEMORY_MOCK_PROVIDERS: '1',
  };

  if (opts.encrypted) {
    // See IsolatedDaemonEnvOpts doc: forces keystore.ts's getOrCreateKey()
    // down the key-file fallback, never the real OS credential store.
    const registerUrl = pathToFileURL(join(HELPERS_DIR, 'fake-keyring-register.mjs')).href;
    env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], `--import ${registerUrl}`].filter(Boolean).join(' ');
  }

  return { root, configDir, dataDir, env };
}

/** Remove the isolated sandbox (config dir + data dir + everything under root). */
export function cleanupIsolatedDaemonEnv(isolated: IsolatedDaemonEnv): void {
  rmSync(isolated.root, { recursive: true, force: true });
}
