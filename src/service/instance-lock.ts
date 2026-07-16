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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Socket } from 'node:net';

const execFileAsync = promisify(execFile);

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

/**
 * Maximum allowed drift between the lock's recorded `startedAt` (our own
 * wall-clock read at acquire time) and the OS-reported process creation
 * time for that PID. Generous enough to absorb normal process-boot latency
 * (require chain, config load) before `acquireInstanceLock` stamps the
 * lock, but far tighter than "PID recycled minutes or hours after a crash"
 * — the exact gap this check exists to close.
 */
const IDENTITY_TOLERANCE_MS = 60_000;

/**
 * Resolve the OS-reported creation time of `pid`, or null when it cannot be
 * determined (process gone, permission denied, unparseable output, or an
 * unsupported platform). Callers MUST treat null as "cannot prove identity"
 * — never as a pass.
 */
export async function getProcessStartTime(pid: number): Promise<Date | null> {
  try {
    if (process.platform === 'win32') {
      // Fast path FIRST: Get-Process .StartTime is a direct Win32 API read
      // (~2s = PowerShell startup only). Fall back to Get-CimInstance (WMI)
      // inside the SAME shell only when the fast path can't answer —
      // .StartTime throws for another user's/elevated process, where WMI can
      // still see CreationDate. wmic itself is deprecated/removed on current
      // Windows builds. The old CIM-only version was measured at 15.5–16s on
      // a loaded box (2026-07-15: over its own 15s timeout, so EVERY identity
      // check failed closed — reinstall could not stop the daemon, and the
      // instance-lock test suite flaked the same way). The timeout is
      // deliberately generous: a tight timeout doesn't make the check faster,
      // it makes it fail closed every time, silently neutering the
      // watchdog/reinstall paths this check exists to keep working. The two
      // sources differ only at sub-microsecond precision — far inside
      // IDENTITY_TOLERANCE_MS.
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-Command',
        `$t = $null; try { $t = (Get-Process -Id ${pid} -ErrorAction Stop).StartTime } catch {}; ` +
        `if ($t) { $t.ToUniversalTime().ToString('o') } ` +
        `else { $p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString('o') } }`,
      ], { timeout: 45_000, windowsHide: true });
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const d = new Date(trimmed);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 15_000 });
      const trimmed = stdout.trim();
      if (!trimmed) return null;
      const d = new Date(trimmed);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    // Linux (and other /proc-bearing POSIX): /proc/<pid>/stat field 22
    // (starttime, in clock ticks since boot). comm (field 2) is
    // parenthesized and may itself contain spaces, so split after the
    // LAST ')' rather than by fixed field index.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim();
    const fields = afterComm.split(/\s+/);
    // fields[0] is field-3 overall (state); starttime is field-22 overall
    // => fields[22 - 3] = fields[19].
    const starttimeTicks = Number(fields[19]);
    if (!Number.isFinite(starttimeTicks)) return null;
    const uptimeSeconds = Number(readFileSync('/proc/uptime', 'utf8').split(' ')[0]);
    if (!Number.isFinite(uptimeSeconds)) return null;
    const CLK_TCK = 100; // USER_HZ — standard across Linux distros
    const bootTimeMs = Date.now() - uptimeSeconds * 1000;
    return new Date(bootTimeMs + (starttimeTicks / CLK_TCK) * 1000);
  } catch {
    return null;
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

/**
 * Check whether something is actively listening on 127.0.0.1:<port>.
 *
 * Used by the zombie-takeover path (issue #389) to tell apart a recycled-PID
 * holder (identity mismatch, but nothing is actually bound to the port —
 * takeover is safe, there is nothing to race) from a holder that is
 * genuinely still bound (takeover would race the new listener's own
 * `app.listen()` into an EADDRINUSE crash loop, issue #387's original bug).
 *
 * ECONNREFUSED is the only outcome that proves "free". A successful connect
 * proves "in use". A timeout or any other connection error cannot prove
 * either way, so both fail CLOSED as "in use" — the same fail-closed posture
 * `stopLockHolder`'s identity check already uses: we would rather over-refuse
 * a takeover than under-refuse one and race a live listener.
 */
export function isPortInUse(port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const socket = new Socket();
    let settled = false;
    const finish = (inUse: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(true));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      finish(err.code !== 'ECONNREFUSED');
    });
    socket.connect(port, '127.0.0.1');
  });
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

/**
 * Machine-readable sub-case for a `StopLockHolderResult` with `ok: false`.
 * `detail` is the human-readable message; `reason` is for callers (like
 * `restore --force`) that need to tell "identity could not be checked" apart
 * from "identity was checked and is confirmed wrong" without pattern-matching
 * the prose.
 *
 *  - `identity-unverifiable` — the check could not run at all (malformed
 *    lock, or the OS query itself failed). Identity is UNKNOWN, not wrong.
 *  - `identity-mismatch`     — the check ran successfully and the OS-reported
 *    start time does NOT match the lock's recorded one. Identity is
 *    CONFIRMED wrong (almost certainly a recycled PID).
 *  - `signal-failed`         — identity was confirmed fine; sending the
 *    signal itself failed (OS-level, e.g. permissions).
 *  - `stop-timeout`          — identity was confirmed fine and the signal was
 *    sent, but the holder kept answering /health past the wait budget.
 */
export type StopLockHolderFailureReason =
  | 'identity-unverifiable'
  | 'identity-mismatch'
  | 'signal-failed'
  | 'stop-timeout';

export interface StopLockHolderResult {
  ok: boolean;
  detail: string;
  /** Present only when `ok: false` — see `StopLockHolderFailureReason`. */
  reason?: StopLockHolderFailureReason;
}

export interface StopLockHolderOptions {
  /** Injectable signal sender — tests substitute a spy instead of really killing a PID. */
  signal?: (pid: number, signal: NodeJS.Signals | number) => void;
  /** Injectable liveness probe — tests substitute a stub instead of real fetch. */
  healthProbe?: (port: number) => Promise<boolean>;
  /** Total time to wait for /health to stop answering after signaling. Default 5000ms. */
  waitMs?: number;
  /** Injectable process-start-time resolver — tests substitute a stub instead of shelling out to the OS. */
  processStartTime?: (pid: number) => Promise<Date | null>;
  /**
   * When true, bypass the `identity-mismatch` drift refusal below (issue
   * #307: a crash-looped daemon whose lock's recorded `startedAt` has
   * drifted — e.g. a clock jump, or a lock format change across an upgrade
   * — could never be stopped via the CLI, with no documented recovery).
   * Does NOT touch the other three failure reasons (`identity-unverifiable`,
   * `signal-failed`, `stop-timeout`) — those still fail closed exactly as
   * before. Default false: the drift guard stays ON unless a caller opts in
   * explicitly. The drift is still computed and logged when bypassed, so
   * the operator can see exactly what was overridden.
   */
  force?: boolean;
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
  const resolveStartTime = opts.processStartTime ?? getProcessStartTime;

  if (!pidAlive(holder.pid)) {
    return { ok: true, detail: `stale lock (pid ${holder.pid} already dead)` };
  }

  // PID-alive is not identity. A crash can leave a stale lock behind; the OS
  // then recycles the PID for an unrelated process, and "alive" alone would
  // make us signal it. Confirm the live process at holder.pid actually
  // started when the lock says it did, BEFORE ever sending a signal. Any
  // failure to determine this — unreadable /proc entry, a failed OS query,
  // a missing/corrupt startedAt — fails CLOSED: we have not proven this is
  // our daemon, so we do not touch it.
  const recordedStart = holder.startedAt ? new Date(holder.startedAt) : null;
  if (!recordedStart || Number.isNaN(recordedStart.getTime())) {
    return {
      ok: false,
      detail: `refusing to signal pid ${holder.pid}: lock has no valid startedAt to verify identity against`,
      reason: 'identity-unverifiable',
    };
  }
  const actualStart = await resolveStartTime(holder.pid);
  if (!actualStart) {
    return {
      ok: false,
      detail: `refusing to signal pid ${holder.pid}: could not verify process identity (unable to determine OS process start time)`,
      reason: 'identity-unverifiable',
    };
  }
  const driftMs = Math.abs(actualStart.getTime() - recordedStart.getTime());
  if (driftMs > IDENTITY_TOLERANCE_MS) {
    const driftDetail = `process start time mismatch (lock says ${holder.startedAt}, OS says ${actualStart.toISOString()}, drift ${driftMs}ms > ${IDENTITY_TOLERANCE_MS}ms) — likely a recycled PID, not our daemon`;
    if (!opts.force) {
      return {
        ok: false,
        detail: `refusing to signal pid ${holder.pid}: ${driftDetail}`,
        reason: 'identity-mismatch',
      };
    }
    // --force: still log what the drift WAS before overriding, so the
    // operator has a record of exactly what guard was bypassed.
    console.error(
      `[astramem-local] WARNING: --force overriding recycled-PID guard; signaling pid ${holder.pid} anyway (${driftDetail})`,
    );
  }

  try {
    sendSignal(holder.pid, 'SIGTERM');
  } catch (err) {
    return { ok: false, detail: `kill pid ${holder.pid} failed: ${(err as Error).message}`, reason: 'signal-failed' };
  }

  const waitMs = opts.waitMs ?? 5000;
  const targetPort = holder.port ?? port;
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const healthy = await probe(targetPort);
    if (!healthy) return { ok: true, detail: `stopped pid ${holder.pid}` };
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok: false, detail: `pid ${holder.pid} still serving after ${waitMs}ms`, reason: 'stop-timeout' };
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
 * Thrown when a lock holder fails 3 health probes (looks like a zombie),
 * `stopLockHolder` could not confirm it is actually gone, AND (issue #389)
 * the holder's port is still genuinely bound — so taking over the lock and
 * calling `app.listen()` would risk racing a live listener. Issue #387: the
 * old code logged a warning and stole the lock unconditionally on 3 failed
 * probes — when the "zombie" was actually alive-but-wedged (a daemon stuck
 * before `app.listen()`, e.g. mid an unbounded consolidate setup), the new
 * process's own `listen()` threw `EADDRINUSE`, the crash handler exited 1,
 * and the scheduler's keepalive respawned another instance that repeated the
 * identical misdiagnosis — dozens of exit-1s in a tight loop with no
 * self-heal. Issue #389: `stopLockHolder`'s refusal alone is not proof of
 * danger — a recycled-PID holder (identity-mismatch) also refuses to be
 * signaled, but if it isn't our daemon it isn't bound to our port either, so
 * `acquireInstanceLock` only reaches this error when the port is confirmed
 * still in use. Surfacing this as a distinct, loud error (rather than
 * silently retrying `writeLock`/`listen`) means the caller fails fast with a
 * diagnosable message instead of racing the port.
 */
export class ZombieLockTakeoverError extends Error {
  constructor(public readonly holder: LockInfo, public readonly stopResult: StopLockHolderResult) {
    super(
      `refusing to take over daemon.lock held by pid ${holder.pid} (port ${holder.port}): could not ` +
      `confirm it actually stopped (${stopResult.detail}). Binding our own listener now would risk ` +
      'racing an EADDRINUSE crash loop against a holder that may still be alive (issue #387). ' +
      'Manual intervention required (verify the PID, then `astramem-local service stop` or kill it directly).',
    );
    this.name = 'ZombieLockTakeoverError';
  }
}

/**
 * Acquire the single-instance lock for `dataDir`.
 *
 * Throws AlreadyRunningError when a healthy daemon already holds it.
 * Throws ZombieLockTakeoverError (issue #387) when the holder fails 3
 * health probes but cannot be confirmed stopped — we must never return a
 * lock handle (and let the caller proceed to `app.listen()`) while the old
 * holder might still own the port.
 * Returns a handle whose release() is idempotent and safe from crash handlers.
 */
export async function acquireInstanceLock(
  dataDir: string,
  port: number,
  version: string,
  opts: {
    healthProbe?: (port: number) => Promise<boolean>;
    /** Injectable signal sender for the zombie-stop path — tests substitute a spy instead of really killing a PID. Threaded through to `stopLockHolder`. */
    signal?: (pid: number, signal: NodeJS.Signals | number) => void;
    /** Injectable process-start-time resolver for the zombie-stop path's identity check. Threaded through to `stopLockHolder`. */
    processStartTime?: (pid: number) => Promise<Date | null>;
    /** Total time to wait for the zombie holder's /health to stop answering after signaling it. Threaded through to `stopLockHolder`'s `waitMs`. */
    zombieStopWaitMs?: number;
    /** Injectable port-liveness probe for the zombie-stop path's port-free check (issue #389) — tests substitute a stub instead of a real socket connect. */
    portInUse?: (port: number) => Promise<boolean>;
  } = {},
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
        `is unresponsive (3 probes) — treating as zombie; verifying it is actually gone before taking over.`,
      );
      // issue #387: never take over the lock (and hand control back to
      // serve.ts to bind the port) on health-unresponsiveness alone — reuse
      // stopLockHolder's identity-checked kill so a merely-wedged (not
      // dead) holder is actually terminated first, or the takeover refuses.
      const stopResult = await stopLockHolder(dataDir, holder.port ?? port, {
        healthProbe: probe,
        signal: opts.signal,
        processStartTime: opts.processStartTime,
        waitMs: opts.zombieStopWaitMs,
      });
      if (!stopResult.ok) {
        // issue #389: stopLockHolder's refusal alone isn't proof the holder is
        // still dangerous — a recycled PID (identity-mismatch) refuses to be
        // signaled by design, but if it isn't OUR daemon it also isn't bound
        // to our port. Check the port directly before treating that refusal
        // as a takeover blocker; only a genuinely-bound port means there is
        // something to race.
        const checkPortInUse = opts.portInUse ?? isPortInUse;
        const targetPort = holder.port ?? port;
        const portBusy = await checkPortInUse(targetPort);
        if (portBusy) {
          throw new ZombieLockTakeoverError(holder, stopResult);
        }
        console.warn(
          `[astramem-local] zombie holder pid ${holder.pid} could not be confirmed stopped (${stopResult.detail}), ` +
          `but port ${targetPort} is free — nothing to race, proceeding with takeover.`,
        );
      } else {
        console.warn(
          `[astramem-local] zombie holder pid ${holder.pid} confirmed stopped (${stopResult.detail}) — taking over the lock.`,
        );
      }
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
