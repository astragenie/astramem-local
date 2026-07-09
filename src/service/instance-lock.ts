/**
 * instance-lock.ts — single-instance protection for the daemon (D2).
 *
 * The lock protects the DATA DIRECTORY (the real single-writer invariant),
 * not just the TCP port: a second daemon on a different port pointed at the
 * same memory.sqlite would race the job queue and contend for writes.
 *
 * Lock file: <dataDir>/daemon.lock — JSON { pid, startedAt, port, version }.
 *
 * Acquisition:
 *  1. Exclusive create ('wx') succeeds → we own the lock.
 *  2. Exists → read holder. Dead PID → stale, steal.
 *  3. Holder PID alive → probe its /health (2s timeout, 3 attempts). Healthy
 *     → AlreadyRunningError (caller exits 0 — this makes schtasks keepalive
 *     re-runs cheap no-ops). Unhealthy 3× → zombie (hung process or a
 *     foreign PID that recycled the id) → steal loudly.
 *
 * Steal = atomic tmp+rename overwrite, same pattern as migrate-encrypt.ts.
 */
import { openSync, closeSync, writeSync, readFileSync, writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface LockInfo {
  pid: number;
  startedAt: string;
  port: number;
  version: string;
}

export interface InstanceLock {
  path: string;
  release(): void;
}

export class AlreadyRunningError extends Error {
  constructor(public readonly holder: LockInfo) {
    super(`astramem-local already running (pid ${holder.pid}, port ${holder.port}, since ${holder.startedAt})`);
    this.name = 'AlreadyRunningError';
  }
}

export function lockPath(dataDir: string): string {
  return join(dataDir, 'daemon.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (genuinely dead). EPERM = the process EXISTS but
    // we lack permission to signal it → still ALIVE. Treating EPERM as dead
    // would let `service stop` / reinstall rollback silently leave a live
    // daemon running while reporting success — the exact failure this helper exists to prevent.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function healthOk(port: number, timeoutMs = 2000): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function writeLock(path: string, info: LockInfo, exclusive: boolean): void {
  const body = JSON.stringify(info);
  if (exclusive) {
    const fd = openSync(path, 'wx');
    try {
      writeSync(fd, body);
    } finally {
      closeSync(fd);
    }
  } else {
    // Steal: atomic tmp+rename so a concurrent reader never sees a torn file.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, body);
    renameSync(tmp, path);
  }
}

/** Read the current lock holder for a data dir (null when absent/corrupt). */
export function readLockInfo(dataDir: string): LockInfo | null {
  return readLock(lockPath(dataDir));
}

export interface StopLockHolderResult {
  ok: boolean;
  detail: string;
}

export interface StopLockHolderOptions {
  /** Injectable signal sender — tests substitute a spy instead of really killing a PID. */
  signal?: (pid: number, signal: NodeJS.Signals | number) => void;
  /** Injectable liveness probe — tests substitute a stub instead of real fetch. */
  healthProbe?: (port: number) => Promise<boolean>;
  /** Total time to wait for /health to stop answering after signaling. Default 5000ms. */
  waitMs?: number;
}

/**
 * Terminate whichever process actually holds `dataDir`'s daemon.lock, by PID
 * — not by asking the OS service manager to stop.
 *
 * Needed because the scheduler-level stop (schtasks `/end`, `systemctl
 * stop`, `launchctl unload`) only ends the launcher process it directly
 * started; `launch.cjs` (shim.ts) spawns the real daemon as a child via
 * `spawnSync`, and that child can keep running — still holding the port and
 * this lock — after the launcher/task is reported "stopped". `service stop`
 * used to report success while `/health` kept answering because of exactly
 * this gap.
 *
 * Idempotent: no lock, or a lock whose PID is already dead, both return
 * `ok: true` with no error. Cross-platform: `process.kill(pid, 'SIGTERM')`
 * force-terminates on Windows (no handler runs — same as the existing
 * `reinstall` stop path) and delivers a real, gracefully-handled SIGTERM on
 * POSIX (`serve.ts` has a `process.on('SIGTERM', shutdown)` handler).
 */
export async function stopLockHolder(
  dataDir: string,
  port: number,
  opts: StopLockHolderOptions = {},
): Promise<StopLockHolderResult> {
  const holder = readLockInfo(dataDir);
  if (!holder) return { ok: true, detail: 'no daemon.lock — nothing to stop' };

  const sendSignal = opts.signal ?? ((pid, sig) => process.kill(pid, sig));
  const probe = opts.healthProbe ?? healthOk;

  if (!pidAlive(holder.pid)) {
    return { ok: true, detail: `stale lock (pid ${holder.pid} already dead)` };
  }

  try {
    sendSignal(holder.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, detail: `kill pid ${holder.pid} failed: ${(err as Error).message}` };
  }

  const waitMs = opts.waitMs ?? 5000;
  const targetPort = holder.port ?? port;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const healthy = await probe(targetPort);
    if (!healthy) return { ok: true, detail: `stopped pid ${holder.pid}` };
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok: false, detail: `pid ${holder.pid} still serving after ${waitMs}ms` };
}

function readLock(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.port !== 'number') return null;
    return {
      pid: parsed.pid,
      port: parsed.port,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      version: typeof parsed.version === 'string' ? parsed.version : '',
    };
  } catch {
    // Unreadable/corrupt lock → treat as stale.
    return null;
  }
}

/**
 * Acquire the single-instance lock for `dataDir`.
 *
 * Throws AlreadyRunningError when a healthy daemon already holds it.
 * Returns a handle whose release() is idempotent and safe from crash handlers.
 */
export async function acquireInstanceLock(
  dataDir: string,
  port: number,
  version: string,
  opts: { healthProbe?: (port: number) => Promise<boolean> } = {},
): Promise<InstanceLock> {
  const path = lockPath(dataDir);
  const probe = opts.healthProbe ?? healthOk;
  const mine: LockInfo = { pid: process.pid, startedAt: new Date().toISOString(), port, version };

  let exclusive = true;
  if (existsSync(path)) {
    const holder = readLock(path);
    if (holder && pidAlive(holder.pid) && holder.pid !== process.pid) {
      // PID alive — is it actually serving?
      let healthy = false;
      for (let i = 0; i < 3 && !healthy; i++) {
        healthy = await probe(holder.port);
      }
      if (healthy) throw new AlreadyRunningError(holder);
      console.warn(
        `[astramem-local] daemon.lock held by pid ${holder.pid} but /health on port ${holder.port} ` +
        `is unresponsive (3 probes) — treating as zombie and taking over the lock.`,
      );
    }
    exclusive = false; // stale/zombie/corrupt → steal via tmp+rename
  }

  try {
    writeLock(path, mine, exclusive);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      // Raced another starting daemon between existsSync and open('wx') —
      // the other process won; defer to it.
      const holder = readLock(path);
      throw new AlreadyRunningError(holder ?? { pid: -1, port, startedAt: '', version: '' });
    }
    throw err;
  }

  let released = false;
  return {
    path,
    release(): void {
      if (released) return;
      released = true;
      try {
        // Only remove the lock if we still own it (a zombie-steal by a newer
        // process must not be deleted by the old holder on its way out).
        const current = readLock(path);
        if (current && current.pid === process.pid) unlinkSync(path);
      } catch {
        /* best-effort — lock steal handles leftovers */
      }
    },
  };
}
