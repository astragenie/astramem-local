/**
 * watchdog-probe.ts — hang-detection for the OS-scheduled daemon (FEAT-443
 * SLICE-2, extended to win32 for issue #206).
 *
 * The gap this closes: systemd's `Restart=on-failure`, launchd's
 * `KeepAlive`, and Windows' PT5M logon-trigger repetition (task-xml.ts) all
 * only fire when the daemon PROCESS EXITS — or, on Windows, treat a still-held
 * `daemon.lock` as proof of health. A daemon that is alive but wedged
 * (blocked event loop, deadlocked native call, a synchronous better-sqlite3
 * query that never returns, ...) keeps holding `daemon.lock` and answering
 * nothing. None of the three mechanisms ever notices: a held lock is not
 * evidence of health, only `/health` answering is (instance-lock.ts).
 *
 * A genuine `sd_notify`/`WatchdogSec` integration would need the daemon's
 * OWN runtime to emit periodic keepalive datagrams over `$NOTIFY_SOCKET` —
 * Node has no built-in Unix DATAGRAM socket support
 * (nodejs/node#61933), so doing that without a native addon means shelling
 * out to the `systemd-notify` CLI from inside the daemon's own request loop
 * (out of this slice's scope: src/service/* only), and has no launchd or
 * Windows equivalent at all. Instead this implements the documented
 * fallback: a periodic EXTERNAL probe (systemd `OnUnitActiveSec` timer /
 * launchd `StartInterval` agent / a second schtasks task on Windows — see
 * systemd.ts / launchd.ts / schtasks.ts) hits `/health` with a short timeout;
 * on N consecutive failures (see DEFAULT_FAILURE_THRESHOLD below) it
 * force-kills whatever actually holds `daemon.lock` — the same PID-level
 * kill `service stop` already relies on (instance-lock.ts's
 * `stopLockHolder`, chosen BECAUSE a scheduler-level stop/restart only
 * reaches the launcher process (`launch.cjs`), not the detached
 * `spawnSync` child it started — see instance-lock.ts's own header) — then
 * restarts via the adapter. This closes the exact gap the exit-only restart
 * mechanisms leave open, on all three platforms.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stopLockHolder } from './instance-lock.js';
import type { ServiceAdapter } from './types.js';

/**
 * Probe cadence for the generated systemd timer / launchd StartInterval
 * agent. Single source of truth so systemd.ts and launchd.ts stay in
 * lock-step, and so the recovery bound (interval + probe timeout + a
 * restart cycle) stays comfortably under the Windows PT5M (5 min) keepalive
 * this mirrors.
 */
export const WATCHDOG_PROBE_INTERVAL_SEC = 180;

/** Default /health request timeout — generous enough that a merely-busy
 *  (not hung) daemon under load always answers well inside it; see the
 *  reinstall.ts DEFAULT_HEALTH_TIMEOUT_MS comment for the kind of boot-time
 *  contention that can legitimately delay a response. Note this has to cover
 *  the SAME endpoint under load a real incident hit: /dashboard cold-renders
 *  in ~7.9s on a box with 15k+ memories because better-sqlite3 is
 *  synchronous and blocks the whole event loop — a concurrent /health
 *  request queues up behind it, not just /dashboard callers. 10s stays
 *  comfortably above that.
 */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Consecutive /health failures required before the probe actually kills and
 * restarts anything (AC-4, issue #206). Each probe invocation is a fresh,
 * short-lived process (scheduler timer tick / schtasks run) with no
 * in-memory memory of the previous tick, so the count is persisted on disk
 * per data dir (see watchdogStatePath below) and reset to 0 the moment
 * `/health` answers again.
 *
 * Why 2, not 1: a genuinely wedged daemon (the failure mode this file exists
 * to catch) cannot recover on its own — every subsequent probe fails too, so
 * the second consecutive failure always arrives, just one interval later. A
 * merely slow-but-healthy daemon under load (the observed 7.9s dashboard
 * cold-render, or a burst of concurrent requests queued behind one
 * synchronous query) is already comfortably inside DEFAULT_PROBE_TIMEOUT_MS
 * and essentially never fails even a single probe, let alone two in a row —
 * so requiring 2 costs nothing in the common case and only adds one extra
 * interval of detection latency in the rare genuine-hang case, while
 * filtering out a single anomalous probe (a GC pause, a transient network
 * hiccup, a request that straddles the timeout boundary by chance) that
 * would otherwise trigger a needless kill-and-restart of a healthy process —
 * exactly the false-positive outcome AC-3 warns is worse than no watchdog.
 */
export const DEFAULT_FAILURE_THRESHOLD = 2;

export interface WatchdogTimerAdapter {
  /** Register the periodic hang-probe timer/agent. Idempotent — same
   *  overwrite-in-full discipline as installBackupTimer. */
  installWatchdogTimer(execPath: string, intervalSec: number): Promise<void>;
  /** Remove the hang-probe timer/agent. No-op if never installed. */
  uninstallWatchdogTimer(): Promise<void>;
}

/**
 * Duck-typed capability check — deliberately NOT part of the shared
 * `ServiceAdapter` interface, so plain-object test mocks that satisfy
 * `ServiceAdapter` without these two methods (e.g.
 * tests/service/install-flow.test.ts's older fixtures) simply don't match,
 * and callers skip the feature safely instead of throwing. All three
 * platform adapters (systemd.ts, launchd.ts, schtasks.ts) implement it as of
 * issue #206.
 */
export function hasWatchdogTimer(
  adapter: ServiceAdapter,
): adapter is ServiceAdapter & WatchdogTimerAdapter {
  const a = adapter as Partial<WatchdogTimerAdapter>;
  return typeof a.installWatchdogTimer === 'function' && typeof a.uninstallWatchdogTimer === 'function';
}

export interface WatchdogProbeOptions {
  port: number;
  dataDir: string;
  adapter: ServiceAdapter;
  timeoutMs?: number;
  /** Consecutive /health failures required before acting (AC-4). Defaults to
   *  DEFAULT_FAILURE_THRESHOLD. */
  failureThreshold?: number;
  /** Injectable fetch — tests substitute a stub instead of a live daemon. */
  fetchImpl?: typeof fetch;
  /** Injectable stopLockHolder — tests substitute a stub instead of really
   *  signaling a PID. Defaults to the real instance-lock.ts implementation. */
  stopLockHolderImpl?: typeof stopLockHolder;
  /** Injectable failure-count persistence — tests substitute in-memory
   *  stubs instead of touching disk. Defaults to a JSON file under dataDir. */
  readFailureCountImpl?: (dataDir: string) => number;
  writeFailureCountImpl?: (dataDir: string, count: number) => void;
}

export interface WatchdogProbeResult {
  healthy: boolean;
  action: 'none' | 'below-threshold' | 'restarted' | 'restart-failed';
  detail: string;
}

async function probeHealth(port: number, timeoutMs: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Per-dataDir persisted consecutive-failure count — same directory
 *  convention as daemon.lock (instance-lock.ts). */
function watchdogStatePath(dataDir: string): string {
  return join(dataDir, 'watchdog-probe-state.json');
}

/** Absent/corrupt state reads as 0 — a fresh start, never a false positive. */
function readFailureCount(dataDir: string): number {
  try {
    const parsed = JSON.parse(readFileSync(watchdogStatePath(dataDir), 'utf8')) as { consecutiveFailures?: unknown };
    return typeof parsed.consecutiveFailures === 'number' && parsed.consecutiveFailures >= 0
      ? parsed.consecutiveFailures
      : 0;
  } catch {
    return 0;
  }
}

/** Best-effort — a failed write just means the next tick recomputes from 0,
 *  which only delays action by extending the "consecutive" run, never
 *  causes a spurious kill. */
function writeFailureCount(dataDir: string, count: number): void {
  try {
    writeFileSync(watchdogStatePath(dataDir), JSON.stringify({ consecutiveFailures: count }));
  } catch {
    /* best-effort, see doc comment above */
  }
}

/**
 * Runs one probe cycle. Never throws — this is invoked unattended from a
 * scheduler timer with no one watching stderr in real time; every failure
 * mode is reported back in the result instead.
 */
export async function runWatchdogProbe(opts: WatchdogProbeOptions): Promise<WatchdogProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const failureThreshold = opts.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stopLockHolderFn = opts.stopLockHolderImpl ?? stopLockHolder;
  const readCount = opts.readFailureCountImpl ?? readFailureCount;
  const writeCount = opts.writeFailureCountImpl ?? writeFailureCount;

  const healthy = await probeHealth(opts.port, timeoutMs, fetchImpl);
  if (healthy) {
    writeCount(opts.dataDir, 0);
    return { healthy: true, action: 'none', detail: `/health responded within ${timeoutMs}ms` };
  }

  const consecutiveFailures = readCount(opts.dataDir) + 1;
  if (consecutiveFailures < failureThreshold) {
    writeCount(opts.dataDir, consecutiveFailures);
    return {
      healthy: false,
      action: 'below-threshold',
      detail: `/health unresponsive within ${timeoutMs}ms (failure ${consecutiveFailures}/${failureThreshold}) — waiting for another consecutive failure before acting`,
    };
  }

  try {
    const stopResult = await stopLockHolderFn(opts.dataDir, opts.port);
    if (!stopResult.ok) {
      // stopLockHolder never throws on failure (see instance-lock.ts) — it
      // reports ok:false either when the SIGTERM'd PID is still serving after
      // its wait budget (the "event loop too wedged to process the signal"
      // case this probe exists to catch), OR when it refused to signal at
      // all because it could not verify the lock holder's identity (recycled
      // PID, unreadable OS process info). Either way nothing was killed and
      // no restart happened. Do NOT call adapter.start()
      // here: on systemd that's a no-op against an already-"active" unit,
      // and on launchd there's no guarantee kickstart -k reaches an orphaned
      // spawnSync grandchild either — either way, claiming 'restarted' would
      // be a false-positive recovery signal from the one thing whose whole
      // job is honest hang reporting. Leave it for the next probe cycle.
      // Deliberately do NOT reset the failure count here: it's already at
      // (or above) the threshold, so the very next tick retries the
      // kill+restart immediately instead of waiting through another full
      // below-threshold run — the daemon is confirmed hung, not merely
      // suspected.
      writeCount(opts.dataDir, consecutiveFailures);
      return {
        healthy: false,
        action: 'restart-failed',
        detail: `hang detected (/health unresponsive within ${timeoutMs}ms) but could not stop the hung process: ${stopResult.detail} — daemon likely still wedged, NOT restarted`,
      };
    }
    await opts.adapter.start();
    writeCount(opts.dataDir, 0);
    return {
      healthy: false,
      action: 'restarted',
      detail: `hang detected (/health unresponsive within ${timeoutMs}ms) — ${stopResult.detail}; restarted via ${opts.adapter.platform} adapter`,
    };
  } catch (err) {
    // Same reasoning as the stopResult.ok===false branch above — restart
    // itself failed, so keep the count at threshold and retry next tick.
    writeCount(opts.dataDir, consecutiveFailures);
    return {
      healthy: false,
      action: 'restart-failed',
      detail: `hang detected (/health unresponsive within ${timeoutMs}ms) but restart failed: ${(err as Error).message}`,
    };
  }
}
