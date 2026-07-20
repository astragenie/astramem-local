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
 *
 * BOOT-GRACE (2026-07-20 incident): the probe above cannot, on its own, tell
 * a daemon that is SLOW TO BOOT (never bound `/health` yet) apart from one
 * that is genuinely HUNG (was healthy, is now wedged) — both look identical
 * from the outside ("N consecutive `/health` failures"). On a large DB
 * (observed: 573MB SQLCipher) the daemon's pre-bind boot phase (openDb +
 * sqlite-vec load + worker wiring — all BEFORE `app.listen()` in
 * `src/cli/serve.ts`) can take several minutes, comfortably past
 * `DEFAULT_FAILURE_THRESHOLD` consecutive probe intervals. Killing a
 * still-booting daemon just restarts the identical slow boot from scratch —
 * a permanent crash-loop that never converges.
 *
 * The fix: `daemon.lock` (instance-lock.ts) is written by
 * `acquireInstanceLock` BEFORE the slow `bind` callback (openDb/migrate/...)
 * ever runs, so its `{pid, startedAt}` is a reliable per-instance boot-start
 * anchor available from very early in the process's life — well before
 * `/health` can answer. The persisted watchdog state (`WatchdogState`,
 * `watchdogStatePath` below) now tracks which instance (`pid:startedAt`) it
 * belongs to and whether THAT instance has ever answered `/health` at all
 * (`everHealthyThisInstance`). The kill/restart path below only fires once a
 * daemon that WAS healthy stops answering — a daemon that has never once
 * been healthy since it started is presumed to still be booting and is left
 * alone, no matter how many consecutive probes fail, UNLESS it has been
 * alive longer than `BOOT_HARD_CAP_SEC` — the safety valve for a daemon that
 * is genuinely stuck before ever reaching `app.listen()`, not merely slow.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readLockInfo, stopLockHolder, type LockInfo } from './instance-lock.js';
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

/**
 * Restart-storm circuit breaker (2026-07-15 incident, stabilization plan
 * P1.1): on that day the watchdog killed a busy-but-alive daemon 5 times in
 * ~2 hours — each kill re-enqueued the orphaned jobs at boot, re-saturated
 * the embed path, re-stalled the event loop, and earned the next kill. The
 * kill mechanism itself became the outage. If the watchdog has already
 * killed the daemon RESTART_STORM_THRESHOLD times inside a rolling
 * RESTART_STORM_WINDOW_MS, it stops killing and reports
 * `action: 'breaker-tripped'` instead; the restart-storm doctor check (RED,
 * src/doctor/checks/restart-storm.ts) is the operator signal.
 *
 * Fail-open direction is deliberate: every observed instance of this class
 * was busy-misclassified-as-dead, where another kill only makes things
 * worse. The accepted tradeoff is that a GENUINELY wedged daemon that trips
 * the breaker stays wedged until a human responds to the doctor RED — that
 * costs response latency, not correctness, while the old behavior actively
 * destroyed work in the common case.
 *
 * Hardcoded consts (not config.yaml) on the CRASH_LOOP_THRESHOLD precedent:
 * one more governance-fallback config value is one more place for defaults
 * to drift (see the DEFAULT_* const trap in CLAUDE.md).
 *
 * No explicit reset/trip flag is persisted: the window is recomputed from
 * the kill log on every tick, so the breaker self-clears once kills age
 * past the window.
 */
export const RESTART_STORM_THRESHOLD = 3;
export const RESTART_STORM_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * Safety-valve absolute cap (2026-07-20 boot-grace fix): a daemon instance
 * that has NEVER answered `/health` since it started is normally never
 * killed, no matter how many consecutive probes fail (see the boot-grace
 * doc comment at the top of this file) — but that must not mean "wait
 * forever" for an instance that is genuinely stuck before ever reaching
 * `app.listen()` (a real deadlock during openDb/migrate/provider wiring, not
 * merely a slow one). Once a never-healthy instance has been alive (per its
 * own `daemon.lock` `startedAt`) longer than this cap, it is killed exactly
 * once and the reason is logged loudly — distinct from the ordinary
 * was-healthy-then-hung kill path below.
 *
 * Deliberately generous: a 573MB SQLCipher DB under disk contention was
 * observed taking ~6-8 minutes to bind on the affected box. 20 minutes
 * leaves ample headroom above that worst-observed case while still bounding
 * a truly-wedged boot instead of leaving it stuck forever.
 */
export const BOOT_HARD_CAP_SEC = 1200;

/** One line per actual watchdog kill (only the `stopResult.ok === true`
 *  path — refused/failed stops don't count; nothing died). */
export interface WatchdogKillEvent {
  ts: string; // ISO-8601
}

/** Append-only kill log — same per-dataDir convention as
 *  watchdog-probe-state.json below. NOT under logs/: the logs dir belongs to
 *  the daemon's own rotation sweep, and this file must never be rotated away
 *  from under the breaker's 6h window. */
export function watchdogKillsPath(dataDir: string): string {
  return join(dataDir, 'watchdog-kills.jsonl');
}

/**
 * Pure parse of kill-log content: timestamps (epoch ms) inside the rolling
 * window, oldest first. Malformed LINES are skipped (per-line, never fatal);
 * this function itself never touches the filesystem. Exported separately
 * from {@link readKillsInWindow} so callers who need to distinguish "file
 * unreadable" from "no kills" (the doctor check's inconclusive path) can do
 * their own read and still share this parsing.
 */
export function parseKillLog(content: string, nowMs: number, windowMs: number): number[] {
  return content
    .split('\n')
    .filter(Boolean)
    .map((line): number | null => {
      try {
        const parsed = JSON.parse(line) as Partial<WatchdogKillEvent>;
        const ms = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : NaN;
        return Number.isFinite(ms) ? ms : null;
      } catch {
        return null;
      }
    })
    .filter((ms): ms is number => ms !== null && nowMs - ms <= windowMs && ms <= nowMs);
}

/**
 * Kill timestamps (epoch ms) inside the rolling window, oldest first.
 * Never throws: an unreadable/missing/malformed log degrades to [] — a read
 * glitch must not trip the breaker (that would silently disable the
 * watchdog), and equally must not crash the probe. Callers who must NOT
 * conflate unreadable-with-empty (doctor's restart-storm check) should read
 * the file themselves and call {@link parseKillLog}.
 */
export function readKillsInWindow(
  dataDir: string,
  nowMs: number = Date.now(),
  windowMs: number = RESTART_STORM_WINDOW_MS,
): number[] {
  try {
    return parseKillLog(readFileSync(watchdogKillsPath(dataDir), 'utf8'), nowMs, windowMs);
  } catch {
    return [];
  }
}

/** Best-effort append — a failed write means this kill is invisible to the
 *  breaker window, which only delays a future trip, never causes one. */
function appendKillEvent(dataDir: string): void {
  try {
    appendFileSync(watchdogKillsPath(dataDir), `${JSON.stringify({ ts: new Date().toISOString() } satisfies WatchdogKillEvent)}\n`);
  } catch {
    /* best-effort, see doc comment above */
  }
}

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
  /** Injectable watchdog-state persistence — tests substitute in-memory
   *  stubs instead of touching disk. Defaults to a JSON file under dataDir
   *  (see `WatchdogState` / `watchdogStatePath`). */
  readStateImpl?: (dataDir: string) => WatchdogState;
  writeStateImpl?: (dataDir: string, state: WatchdogState) => void;
  /** Injectable `daemon.lock` reader — identifies the CURRENT daemon
   *  instance (`pid:startedAt`) so the boot-grace gate can tell "never
   *  healthy, still booting" apart from "was healthy, now hung", and can
   *  compute how long a never-healthy instance has been alive for the
   *  `BOOT_HARD_CAP_SEC` safety valve. Defaults to the real
   *  instance-lock.ts `readLockInfo`. */
  readLockInfoImpl?: (dataDir: string) => LockInfo | null;
  /** Boot-grace hard-cap override (ms) — tests substitute a tiny value
   *  instead of the real `BOOT_HARD_CAP_SEC` default. */
  bootHardCapMs?: number;
  /** Restart-storm breaker knobs/seams (P1.1) — tests substitute in-memory
   *  kill logs and a fixed clock; production always uses the defaults. */
  restartStormThreshold?: number;
  restartStormWindowMs?: number;
  readKillsInWindowImpl?: typeof readKillsInWindow;
  appendKillEventImpl?: (dataDir: string) => void;
  nowMs?: number;
}

export interface WatchdogProbeResult {
  healthy: boolean;
  action: 'none' | 'below-threshold' | 'still-booting' | 'breaker-tripped' | 'restarted' | 'restart-failed';
  detail: string;
}

/**
 * Persisted watchdog state (per dataDir, `watchdogStatePath` below) — same
 * file `{consecutiveFailures}` used to live in alone, now extended (2026-07-20
 * boot-grace fix) with per-instance identity so a hang recorded against one
 * daemon process can never be misattributed to its successor.
 *
 *  - `consecutiveFailures` — unchanged: consecutive `/health` failures
 *    against the CURRENT instance, reset to 0 the moment it answers.
 *  - `instanceKey` — `${pid}:${startedAt}` of the `daemon.lock` holder this
 *    state was last observed against, or `null` when no lock could be read.
 *    A probe that reads a DIFFERENT key than the one persisted here means a
 *    new daemon process has taken over since the last tick — see the reset
 *    logic in `runWatchdogProbe`.
 *  - `everHealthyThisInstance` — has THIS instance (by `instanceKey`) ever
 *    answered `/health` at all. Gates the kill path: only a daemon that was
 *    healthy at least once and has since gone silent is treated as hung.
 */
export interface WatchdogState {
  consecutiveFailures: number;
  instanceKey: string | null;
  everHealthyThisInstance: boolean;
}

const DEFAULT_WATCHDOG_STATE: WatchdogState = {
  consecutiveFailures: 0,
  instanceKey: null,
  everHealthyThisInstance: false,
};

/** `${pid}:${startedAt}` identity for a `daemon.lock` holder, or `null` when
 *  no lock could be read (nothing to identify). */
function instanceKeyOf(lock: LockInfo | null): string | null {
  return lock ? `${lock.pid}:${lock.startedAt}` : null;
}

async function probeHealth(port: number, timeoutMs: number, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Per-dataDir persisted watchdog state — same directory convention as
 *  daemon.lock (instance-lock.ts). */
function watchdogStatePath(dataDir: string): string {
  return join(dataDir, 'watchdog-probe-state.json');
}

/** Absent/corrupt state reads as the zero-value default — a fresh start,
 *  never a false positive. */
function readWatchdogState(dataDir: string): WatchdogState {
  try {
    const parsed = JSON.parse(readFileSync(watchdogStatePath(dataDir), 'utf8')) as Partial<WatchdogState>;
    return {
      consecutiveFailures:
        typeof parsed.consecutiveFailures === 'number' && parsed.consecutiveFailures >= 0
          ? parsed.consecutiveFailures
          : 0,
      instanceKey: typeof parsed.instanceKey === 'string' ? parsed.instanceKey : null,
      everHealthyThisInstance: parsed.everHealthyThisInstance === true,
    };
  } catch {
    return { ...DEFAULT_WATCHDOG_STATE };
  }
}

/** Best-effort — a failed write just means the next tick recomputes from the
 *  zero-value default, which only delays action by extending the
 *  "consecutive" run, never causes a spurious kill. */
function writeWatchdogState(dataDir: string, state: WatchdogState): void {
  try {
    writeFileSync(watchdogStatePath(dataDir), JSON.stringify(state));
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
  const readState = opts.readStateImpl ?? readWatchdogState;
  const writeState = opts.writeStateImpl ?? writeWatchdogState;
  const readLock = opts.readLockInfoImpl ?? readLockInfo;
  const nowMs = opts.nowMs ?? Date.now();
  const bootHardCapMs = opts.bootHardCapMs ?? BOOT_HARD_CAP_SEC * 1000;

  const lock = readLock(opts.dataDir);
  const currentInstanceKey = instanceKeyOf(lock);
  let state = readState(opts.dataDir);
  if (currentInstanceKey !== null && currentInstanceKey !== state.instanceKey) {
    // A different daemon instance (fresh pid+startedAt) now holds the lock
    // than the one this state was last recorded against — a restart (ours or
    // otherwise) happened since the last tick. Reset the whole streak so a
    // hang recorded against the OLD instance can never carry over and cause
    // an immediate kill of a brand-new, still-booting one.
    state = { consecutiveFailures: 0, instanceKey: currentInstanceKey, everHealthyThisInstance: false };
  }

  const healthy = await probeHealth(opts.port, timeoutMs, fetchImpl);
  if (healthy) {
    writeState(opts.dataDir, { ...state, consecutiveFailures: 0, everHealthyThisInstance: true });
    return { healthy: true, action: 'none', detail: `/health responded within ${timeoutMs}ms` };
  }

  const consecutiveFailures = state.consecutiveFailures + 1;
  state = { ...state, consecutiveFailures };

  if (consecutiveFailures < failureThreshold) {
    writeState(opts.dataDir, state);
    return {
      healthy: false,
      action: 'below-threshold',
      detail: `/health unresponsive within ${timeoutMs}ms (failure ${consecutiveFailures}/${failureThreshold}) — waiting for another consecutive failure before acting`,
    };
  }

  // Boot-grace gate (2026-07-20 fix): a daemon instance that has NEVER
  // answered /health cannot be distinguished from a genuine hang by probe
  // failures alone — it may simply still be booting (see file header). Only
  // proceed to the kill path below once this instance has been healthy at
  // least once, UNLESS it has outlived the BOOT_HARD_CAP_SEC safety valve.
  let bootHardCapTripped = false;
  if (!state.everHealthyThisInstance) {
    const aliveMs = lock?.startedAt ? nowMs - Date.parse(lock.startedAt) : NaN;
    if (!Number.isFinite(aliveMs) || aliveMs < bootHardCapMs) {
      writeState(opts.dataDir, state);
      return {
        healthy: false,
        action: 'still-booting',
        detail:
          `daemon not yet healthy after ${consecutiveFailures} consecutive probes — still booting, not killing ` +
          `(instance alive ${Number.isFinite(aliveMs) ? `${aliveMs}ms` : 'unknown'}, hard cap ${bootHardCapMs}ms)`,
      };
    }
    bootHardCapTripped = true;
    console.error(
      `[astramem-local] daemon never became healthy within the boot hard-cap (${bootHardCapMs}ms) — genuinely stuck, restarting`,
    );
  }

  // Restart-storm circuit breaker (see RESTART_STORM_THRESHOLD doc comment):
  // consult the kill log BEFORE signaling anything. Failure count is kept
  // (not reset) so the breaker's own state never masks that /health is
  // still failing — once the window clears, the very next tick acts again.
  const stormThreshold = opts.restartStormThreshold ?? RESTART_STORM_THRESHOLD;
  const stormWindowMs = opts.restartStormWindowMs ?? RESTART_STORM_WINDOW_MS;
  const readKills = opts.readKillsInWindowImpl ?? readKillsInWindow;
  const appendKill = opts.appendKillEventImpl ?? appendKillEvent;
  const killsInWindow = readKills(opts.dataDir, nowMs, stormWindowMs);
  if (killsInWindow.length >= stormThreshold) {
    writeState(opts.dataDir, state);
    return {
      healthy: false,
      action: 'breaker-tripped',
      detail:
        `hang detected (/health unresponsive within ${timeoutMs}ms) but the restart-storm breaker is OPEN: ` +
        `${killsInWindow.length} watchdog kill(s) in the last ${Math.round(stormWindowMs / 3_600_000)}h ` +
        `(threshold ${stormThreshold}) — refusing to kill again; kill/restart cycles are making things worse, ` +
        `not better. Operator attention needed (doctor: "Watchdog restart storm" is RED). ` +
        `The breaker self-clears once kills age out of the window.`,
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
      writeState(opts.dataDir, state);
      return {
        healthy: false,
        action: 'restart-failed',
        detail: `hang detected (/health unresponsive within ${timeoutMs}ms) but could not stop the hung process: ${stopResult.detail} — daemon likely still wedged, NOT restarted`,
      };
    }
    // Record the kill the moment the stop actually succeeded — the daemon
    // died whether or not the adapter restart below also succeeds, and the
    // breaker must count exactly the events that destroy in-flight work.
    appendKill(opts.dataDir);
    await opts.adapter.start();
    // Reset consecutiveFailures but keep instanceKey/everHealthyThisInstance
    // as-is — the NEXT tick will observe the newly-spawned process's own
    // fresh daemon.lock (different pid/startedAt) and reset the rest of the
    // state via the instance-change branch above.
    writeState(opts.dataDir, { ...state, consecutiveFailures: 0 });
    return {
      healthy: false,
      action: 'restarted',
      detail:
        `hang detected (/health unresponsive within ${timeoutMs}ms) — ${stopResult.detail}; ` +
        `restarted via ${opts.adapter.platform} adapter` +
        (bootHardCapTripped ? ' [boot hard-cap exceeded — daemon never became healthy since starting]' : ''),
    };
  } catch (err) {
    // Same reasoning as the stopResult.ok===false branch above — restart
    // itself failed, so keep the count at threshold and retry next tick.
    writeState(opts.dataDir, state);
    return {
      healthy: false,
      action: 'restart-failed',
      detail: `hang detected (/health unresponsive within ${timeoutMs}ms) but restart failed: ${(err as Error).message}`,
    };
  }
}
