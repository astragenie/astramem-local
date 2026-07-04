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
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** Repo root, resolved relative to this file — works whether ts-node/vitest
 *  runs it from source or a built copy, and handles the Windows
 *  `/C:/...` → `C:/...` file-URL quirk the same way plugin-flow.test.ts did. */
export const REPO_ROOT = join(
  new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  '..', '..', '..',
);

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
  port: number;
  token: string;
  /** Extra/overriding env vars merged over process.env (e.g. ASTRA_MEMORY_DATADIR,
   *  ASTRA_MEMORY_MOCK_PROVIDERS, APPDATA/HOME/XDG_CONFIG_HOME overrides). */
  env?: Record<string, string>;
  cwd?: string;
}

/** Spawn `node dist/cli/index.js serve --port <port>` with the given env. */
export function spawnDaemon(opts: SpawnDaemonOpts): DaemonHandle {
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

  return {
    proc,
    port: opts.port,
    token: opts.token,
    baseUrl: `http://127.0.0.1:${opts.port}`,
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
   *  this test. Config encryption is disabled via config.yaml so serve.ts
   *  never calls getOrCreateKey() (no OS Credential Manager access either). */
  env: Record<string, string>;
}

/**
 * Create an isolated temp config dir (config.yaml with encryption disabled)
 * + temp data dir + a sandboxed "local app data" dir, and return the env
 * overrides that keep a spawned daemon entirely inside them. Never touches
 * the real %APPDATA%\Astramem / %LOCALAPPDATA%\Astramem (or the legacy
 * AstraMemory dirs) on the host.
 */
export function makeIsolatedDaemonEnv(prefix: string): IsolatedDaemonEnv {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  const localAppData = join(root, 'localappdata');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(localAppData, { recursive: true });

  writeFileSync(
    join(configDir, 'config.yaml'),
    "security:\n  encryption:\n    enabled: false\n",
    'utf8',
  );

  const env: Record<string, string> = {
    APPDATA: configDir,
    LOCALAPPDATA: localAppData,
    HOME: configDir,
    XDG_CONFIG_HOME: configDir,
    XDG_DATA_HOME: localAppData,
    ASTRA_MEMORY_DATADIR: dataDir,
    ASTRA_MEMORY_MOCK_PROVIDERS: '1',
  };

  return { root, configDir, dataDir, env };
}

/** Remove the isolated sandbox (config dir + data dir + everything under root). */
export function cleanupIsolatedDaemonEnv(isolated: IsolatedDaemonEnv): void {
  rmSync(isolated.root, { recursive: true, force: true });
}
