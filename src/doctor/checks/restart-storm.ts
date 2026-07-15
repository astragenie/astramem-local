import { existsSync, readFileSync } from 'node:fs';
import type { Check, CheckResult } from '../types.js';
import {
  parseKillLog,
  watchdogKillsPath,
  RESTART_STORM_THRESHOLD,
  RESTART_STORM_WINDOW_MS,
} from '../../service/watchdog-probe.js';

// ─── Check: Watchdog restart storm (stabilization plan P1.1) ─────────────────

/**
 * Reads the watchdog's kill log (watchdog-kills.jsonl, written by
 * runWatchdogProbe on every successful kill) and RED-flags a restart storm:
 * >= RESTART_STORM_THRESHOLD kills inside the rolling
 * RESTART_STORM_WINDOW_MS. This is the operator-facing half of the
 * circuit breaker in src/service/watchdog-probe.ts — when the breaker is
 * OPEN the watchdog has deliberately stopped killing a repeatedly-failing
 * daemon (2026-07-15 incident: 5 kills in ~2h, each one re-triggering the
 * overload that earned the next), so a human MUST see it; the breaker
 * trades automated recovery for this signal.
 *
 * Rate-based per ADR-015 / the canary-rate rule: the message always carries
 * the actual count and window, never a bare boolean.
 */
export function checkRestartStorm(
  dataDir: string,
  threshold = RESTART_STORM_THRESHOLD,
  windowMs = RESTART_STORM_WINDOW_MS,
): Check {
  return {
    name: 'Watchdog restart storm',
    tier: 'cheap', // bounded fs read + parse of watchdog-kills.jsonl
    async run(): Promise<CheckResult> {
      const windowHours = Math.round(windowMs / 3_600_000);
      if (!existsSync(watchdogKillsPath(dataDir))) {
        return { ok: true, message: 'restart storm: no watchdog kills recorded yet' };
      }

      // Deliberately NOT readKillsInWindow: that helper never throws
      // (degrades to []), which would make an unreadable log
      // indistinguishable from an empty one — a false GREEN. Read the file
      // ourselves so a permissions/corruption glitch reports inconclusive
      // (catch-must-not-report-healthy discipline), then share the parser.
      let kills: number[];
      try {
        kills = parseKillLog(readFileSync(watchdogKillsPath(dataDir), 'utf8'), Date.now(), windowMs);
      } catch (err) {
        return { ok: true, inconclusive: true, message: `restart storm: kill log exists but is unreadable (${err}) — not measured` };
      }

      if (kills.length < threshold) {
        return {
          ok: true,
          message: `restart storm: ${kills.length} watchdog kill(s) in the last ${windowHours}h (below threshold of ${threshold})`,
        };
      }

      const timestamps = kills.map(ms => new Date(ms).toISOString()).join(', ');
      return {
        ok: false,
        message:
          `restart storm: ${kills.length} watchdog kill(s) in the last ${windowHours}h [${timestamps}] — ` +
          `the circuit breaker is OPEN and the watchdog has STOPPED killing the daemon. ` +
          `If /health is still failing, the daemon is down or wedged with NO automated recovery active.`,
        fix:
          'Diagnose why the daemon keeps failing /health (event-loop stall? overload? see daemon-stdout.log ' +
          'and daemon.live.log) and fix the cause — do not just restart it again; the storm means restarts ' +
          'were making it worse. The breaker self-clears once kills age out of the window.',
      };
    },
  };
}
