/**
 * Spawn/health/teardown helper for the proxy under test (FEAT-458 W1a,
 * S1-AC-3). Deliberately NOT a fork of ../../shared/spawn-daemon.ts — the
 * proxy entrypoint lives on a DIFFERENT branch (feat/feat-458-s2-proxy-core-v2,
 * worktree w458core: `src/proxy/server.ts` + `src/cli/proxy.ts`), not this
 * one, so nothing here imports proxy source. `resolveProxyEntry` accepts the
 * built CLI path as a parameter/config value, never a hardcoded import, and
 * every caller (bench.mts, this module's own tests) must treat a missing
 * entry as a first-class "not available yet" case, not an error to fix.
 *
 * The spawn/wait-for-boot-line/kill shape below intentionally COPIES
 * ../../shared/spawn-daemon.ts's teardown discipline verbatim (PID-scoped
 * kill only, never touched by signal until the caller's own handle says so,
 * bounded wait-for-exit) — same box, same "never kill by image name" hazard,
 * same fix. It cannot import that module directly because the boot log line
 * differs: the proxy CLI prints
 *   "<ts> astramem-local proxy serving on <host>:<port> -> <upstream>"
 * (src/cli/proxy.ts on w458core, read for interface purposes only) vs. the
 * daemon's "astramem-local serving on <host>:<port>" — different regex,
 * different argv shape (`proxy serve --port N --upstream <url> --host H`
 * vs. `serve --port N`), different enough that forcing a shared abstraction
 * would cost more clarity than it saves for two call sites.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const PROXY_SERVING_LINE_RE = /astramem-local proxy serving on [^\s:]+:(\d+)/;

/**
 * Resolve the built proxy CLI entrypoint: an explicit `--proxy-entry` value
 * always wins; otherwise fall back to `dist/cli/index.js` under `repoRoot`
 * (the same built artifact `../../shared/spawn-daemon.ts` spawns for the
 * daemon) — valid once Wave 2 merges feat/feat-458-s2-proxy-core-v2 and
 * `bun run build` has run, `undefined` (never a throw) beforehand so callers
 * can degrade to a baseline-only run.
 */
export function resolveProxyEntry(explicit: string | undefined, repoRoot: string): string | undefined {
  const candidate = explicit ?? join(repoRoot, 'dist', 'cli', 'index.js');
  return existsSync(candidate) ? candidate : undefined;
}

export interface ProxyHandle {
  proc: ChildProcess;
  pid: number | undefined;
  port: number;
  host: string;
  baseUrl: string;
  stdout(): string;
  stderr(): string;
  exitInfo(): { code: number | null; signal: NodeJS.Signals | null };
}

export interface SpawnProxyOpts {
  /** Built CLI entrypoint, e.g. from resolveProxyEntry() — never assumed
   *  present by this function; the caller decides whether to call spawnProxy
   *  at all. */
  entry: string;
  /** Upstream URL the proxy forwards to — the synthetic stub's baseUrl in
   *  every bench invocation, never a real provider. */
  upstream: string;
  /** Ephemeral by default (0), matching spawn-daemon.ts's convention. */
  port?: number;
  /** Loopback-only, matching the proxy's own ADR-013 bind restriction. */
  host?: string;
  env?: Record<string, string>;
  cwd?: string;
}

async function waitForBoundPort(
  getStdout: () => string,
  getStderr: () => string,
  getExitInfo: () => { code: number | null; signal: NodeJS.Signals | null },
  timeoutMs = 15_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const m = PROXY_SERVING_LINE_RE.exec(getStdout());
    if (m) return Number(m[1]);
    const { code, signal } = getExitInfo();
    if (code !== null || signal !== null) {
      throw new Error(
        `proxy exited before printing its bound port (code=${code} signal=${signal})\n` +
        `stdout:\n${getStdout()}\nstderr:\n${getStderr()}`,
      );
    }
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for the proxy to print its bound port\nstdout:\n${getStdout()}\nstderr:\n${getStderr()}`);
}

export async function spawnProxy(opts: SpawnProxyOpts): Promise<ProxyHandle> {
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  const host = opts.host ?? '127.0.0.1';

  const proc = spawn(
    // Literal 'node', not process.execPath — this harness runs under bun
    // (repo idiom for one-off scripts) but the CLI under test must run under
    // real Node, same rationale as ../../shared/spawn-daemon.ts.
    'node',
    [opts.entry, 'proxy', 'serve', '--port', String(opts.port ?? 0), '--upstream', opts.upstream, '--host', host],
    {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...(process.env as Record<string, string>), ...opts.env },
      stdio: 'pipe',
    },
  );
  proc.stdout?.on('data', (c: Buffer) => { stdout += c.toString(); });
  proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
  proc.on('exit', (code, signal) => { exitCode = code; exitSignal = signal; });

  const actualPort = await waitForBoundPort(() => stdout, () => stderr, () => ({ code: exitCode, signal: exitSignal }));

  return {
    proc,
    pid: proc.pid,
    port: actualPort,
    host,
    baseUrl: `http://${host}:${actualPort}`,
    stdout: () => stdout,
    stderr: () => stderr,
    exitInfo: () => ({ code: exitCode, signal: exitSignal }),
  };
}

/** Identical shape to ../../shared/spawn-daemon.ts's killDaemon — PID-scoped
 *  (signals only the child this module itself spawned), bounded wait, never
 *  a machine-wide sweep. */
export async function killProxy(handle: ProxyHandle, signal: NodeJS.Signals = 'SIGTERM', timeoutMs = 5_000): Promise<void> {
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
