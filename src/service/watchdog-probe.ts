/**
 * watchdog-probe.ts — hang-detection for the OS-scheduled daemon (FEAT-443
 * SLICE-2).
 *
 * The gap this closes: systemd's `Restart=on-failure` and launchd's
 * `KeepAlive` (see systemd.ts / launchd.ts) both only fire when the daemon
 * PROCESS EXITS. A daemon that is alive but wedged (blocked event loop,
 * deadlocked native call, ...) keeps holding `daemon.lock` and answering
 * nothing — neither mechanism ever notices, exactly like the Windows PT5M
 * logon-trigger repetition (task-xml.ts) never notices either, since a
 * healthy-looking re-run only checks whether the lock is held by a live
 * PID, not whether that PID is actually responsive (instance-lock.ts).
 *
 * A genuine `sd_notify`/`WatchdogSec` integration would need the daemon's
 * OWN runtime to emit periodic keepalive datagrams over `$NOTIFY_SOCKET` —
 * Node has no built-in Unix DATAGRAM socket support
 * (nodejs/node#61933), so doing that without a native addon means shelling
 * out to the `systemd-notify` CLI from inside the daemon's own request loop
 * (out of this slice's scope: src/service/* only), and has no launchd
 * equivalent at all. Instead this implements the documented fallback: a
 * periodic EXTERNAL probe (systemd `OnUnitActiveSec` timer / launchd
 * `StartInterval` agent — see systemd.ts / launchd.ts) hits `/health` with a
 * short timeout; on failure it force-kills whatever actually holds
 * `daemon.lock` — the same PID-level kill `service stop` already relies on
 * (instance-lock.ts's `stopLockHolder`, chosen BECAUSE a scheduler-level
 * stop/restart only reaches the launcher process (`launch.cjs`), not the
 * detached `spawnSync` child it started — see instance-lock.ts's own
 * header) — then restarts via the adapter. This closes the exact gap
 * `Restart=on-failure`/`KeepAlive` leave open, mirroring the Windows PT5M
 * keepalive's ≤5-minute recovery bound.
 */
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
 *  contention that can legitimately delay a response. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export interface WatchdogTimerAdapter {
  /** Register the periodic hang-probe timer/agent. Idempotent — same
   *  overwrite-in-full discipline as installBackupTimer. */
  installWatchdogTimer(execPath: string, intervalSec: number): Promise<void>;
  /** Remove the hang-probe timer/agent. No-op if never installed. */
  uninstallWatchdogTimer(): Promise<void>;
}

/**
 * Duck-typed capability check — deliberately NOT part of the shared
 * `ServiceAdapter` interface. This is a systemd/launchd-only capability
 * (FEAT-443 SLICE-2 is scoped to Unix parity; Windows already has its own
 * always-on PT5M keepalive via task-xml.ts, a different mechanism with the
 * same known hang-blind-spot, out of scope here). Plain-object test mocks
 * that satisfy `ServiceAdapter` without these two methods (e.g.
 * tests/service/install-flow.test.ts) simply don't match, so callers can
 * skip the feature safely instead of throwing.
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
  /** Injectable fetch — tests substitute a stub instead of a live daemon. */
  fetchImpl?: typeof fetch;
  /** Injectable stopLockHolder — tests substitute a stub instead of really
   *  signaling a PID. Defaults to the real instance-lock.ts implementation. */
  stopLockHolderImpl?: typeof stopLockHolder;
}

export interface WatchdogProbeResult {
  healthy: boolean;
  action: 'none' | 'restarted' | 'restart-failed';
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

/**
 * Runs one probe cycle. Never throws — this is invoked unattended from a
 * scheduler timer with no one watching stderr in real time; every failure
 * mode is reported back in the result instead.
 */
export async function runWatchdogProbe(opts: WatchdogProbeOptions): Promise<WatchdogProbeResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const stopLockHolderFn = opts.stopLockHolderImpl ?? stopLockHolder;

  const healthy = await probeHealth(opts.port, timeoutMs, fetchImpl);
  if (healthy) {
    return { healthy: true, action: 'none', detail: `/health responded within ${timeoutMs}ms` };
  }

  try {
    const stopResult = await stopLockHolderFn(opts.dataDir, opts.port);
    await opts.adapter.start();
    return {
      healthy: false,
      action: 'restarted',
      detail: `hang detected (/health unresponsive within ${timeoutMs}ms) — ${stopResult.detail}; restarted via ${opts.adapter.platform} adapter`,
    };
  } catch (err) {
    return {
      healthy: false,
      action: 'restart-failed',
      detail: `hang detected (/health unresponsive within ${timeoutMs}ms) but restart failed: ${(err as Error).message}`,
    };
  }
}
