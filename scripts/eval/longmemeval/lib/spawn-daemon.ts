/**
 * Standalone daemon spawn/health helper for the eval harness — deliberately
 * NOT importing tests/smoke/helpers/daemon.ts (that's test-only code; this
 * adapter is new files under scripts/, per the task's "do not modify
 * src/ or existing tests" scope). Same technique (ephemeral port 0, parse
 * the boot log line, poll /health) as that helper, independently.
 *
 * CRITICAL isolation requirement discovered while building this harness
 * (2026-07-08): the real %APPDATA%\Astramem\sync.json on this machine is
 * PAIRED to the live production SaaS tenant (https://api.astramemory.com,
 * a real tenantId). `resolveRuntimeConfig` merges sync.json over config.yaml
 * regardless of ASTRA_MEMORY_DATADIR overrides — so spawning against the
 * real config dir with only the datadir swapped would have sync-shipped
 * every synthetic LongMemEval haystack session into the user's real cloud
 * account. This is why `makeIsolatedEvalEnv` below redirects
 * APPDATA/LOCALAPPDATA/HOME/XDG_* into a throwaway sandbox (same technique
 * as tests/smoke/helpers/daemon.ts's makeIsolatedDaemonEnv, independently
 * authored here) — a fresh config dir has no sync.json (sync defaults to
 * disabled, src/config/config.ts:198) and we explicitly force
 * `security.encryption.enabled: false` (same as that test helper) so boot
 * never touches the real OS credential store either. `defaultConfig()`
 * already points llm/embedding at the real local Ollama models
 * (qwen2.5-coder:7b / mxbai-embed-large) — no config.yaml overrides needed
 * for those, so the eval daemon still exercises the real provider stack.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfigDir } from '../../../../src/config/datadir.js';

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export interface IsolatedEvalEnv {
  root: string;
  configDir: string;
  env: Record<string, string>;
}

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

/** Build a throwaway config/home sandbox for one eval run — never touches
 *  the real %APPDATA%\Astramem (sync pairing) or the real OS credential
 *  store. Caller merges the returned `env` into SpawnDaemonOpts.env. */
export function makeIsolatedEvalEnv(prefix: string): IsolatedEvalEnv {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const appDataRoot = join(root, 'appdata');
  const localAppDataRoot = join(root, 'localappdata');
  mkdirSync(appDataRoot, { recursive: true });
  mkdirSync(localAppDataRoot, { recursive: true });

  const dirEnvOverrides: Record<string, string> = {
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
    HOME: appDataRoot,
    XDG_CONFIG_HOME: appDataRoot,
    XDG_DATA_HOME: localAppDataRoot,
  };

  const configDir = withEnvOverrides(dirEnvOverrides, defaultConfigDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.yaml'), 'security:\n  encryption:\n    enabled: false\n', 'utf8');

  return { root, configDir, env: dirEnvOverrides };
}

export function cleanupIsolatedEvalEnv(isolated: IsolatedEvalEnv): void {
  rmSync(isolated.root, { recursive: true, force: true });
}

const SERVING_LINE_RE = /astramem-local serving on [^\s:]+:(\d+)/;

export interface DaemonHandle {
  proc: ChildProcess;
  port: number;
  token: string;
  baseUrl: string;
  stdout(): string;
  stderr(): string;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null };
}

export interface SpawnDaemonOpts {
  dataDir: string;
  token: string;
  port?: number;
  /** Extra env merged over process.env (e.g. ASTRA_MEMORY_PORT if a fixed
   *  port is ever needed — default is ephemeral `--port 0`). */
  env?: Record<string, string>;
}

async function waitForBoundPort(
  getStdout: () => string,
  getStderr: () => string,
  getExitInfo: () => { code: number | null; signal: NodeJS.Signals | null },
  timeoutMs = 30_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = SERVING_LINE_RE.exec(getStdout());
    if (m) return Number(m[1]);
    const { code, signal } = getExitInfo();
    if (code !== null || signal !== null) {
      throw new Error(
        `eval daemon exited before printing its bound port (code=${code} signal=${signal})\n` +
        `stdout:\n${getStdout()}\nstderr:\n${getStderr()}`,
      );
    }
    await sleep(100);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the eval daemon to print its bound port\nstdout:\n${getStdout()}\nstderr:\n${getStderr()}`);
}

export async function spawnEvalDaemon(opts: SpawnDaemonOpts): Promise<DaemonHandle> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  const proc = spawn(
    // Deliberately literal 'node', NOT process.execPath: this harness itself
    // runs under `bun` (per repo idiom for one-off scripts), but the daemon
    // must run under real Node — CLAUDE.md's hard warning against
    // `astramem-local` shadowing applies equally here, and Bun's own SQLite
    // layer cannot open the daemon's better-sqlite3-multiple-ciphers file
    // (`'better-sqlite3' is not yet supported in Bun` — verified live
    // 2026-07-08 when this was `process.execPath` and resolved to bun.exe).
    'node',
    ['dist/cli/index.js', 'serve', '--port', String(opts.port ?? 0)],
    {
      cwd: REPO_ROOT,
      env: {
        ...(process.env as Record<string, string>),
        ASTRA_MEMORY_DATADIR: opts.dataDir,
        ASTRA_MEMORY_TOKEN: opts.token,
        ...opts.env,
      },
      stdio: 'pipe',
    },
  );
  proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
  proc.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });

  const actualPort = await waitForBoundPort(() => stdout, () => stderr, () => ({ code: exitCode, signal: exitSignal }));

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

export async function waitForHealthStatus(
  baseUrl: string,
  wantStatuses: string[],
  timeoutMs = 60_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        last = body;
        if (body.status && wantStatuses.includes(body.status)) return body.status;
      }
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await sleep(300);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for /health status in [${wantStatuses.join(', ')}] — last observed: ${JSON.stringify(last)}`);
}

export async function killDaemon(handle: DaemonHandle, signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 5_000): Promise<void> {
  const { code, signal: exitSignal } = handle.exitInfo();
  if (handle.proc.killed || code !== null || exitSignal !== null) return;
  try {
    handle.proc.kill(signal);
  } catch {
    return;
  }
  await new Promise<void>(resolve => {
    const t = setTimeout(resolve, timeoutMs);
    handle.proc.on('exit', () => { clearTimeout(t); resolve(); });
  });
}
