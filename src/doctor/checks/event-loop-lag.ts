import type { Check, CheckResult } from '../types.js';
import type { EventLoopLagMonitor, EventLoopLagSnapshot } from '../../server/event-loop-lag.js';

// ─── Check: Event loop lag (stabilization plan P1.2) ─────────────────────────

/**
 * RED when the daemon's event-loop p99 delay over the current window
 * exceeds P99_ALARM_MS. The 2026-07-15 incident stalled the loop 15–219s
 * with NOTHING measuring it — /health timed out (so the watchdog killed the
 * daemon) but no surface reported the stall as a number. This check is the
 * scheduled-doctor half of that measurement; /health's `event_loop` block
 * is the always-on half.
 *
 * Threshold reasoning: measured incident stalls were 15,000–219,000ms; 1s
 * is ~10x a healthy fast-path handler and 10x BELOW the watchdog's 10s
 * probe timeout — the alarm fires several escalation steps before the
 * watchdog would even consider acting.
 *
 * Two read paths:
 *  - in-process (scheduled doctor inside the daemon): reads the live
 *    monitor injected via DoctorCheckOpts.eventLoopLag.
 *  - out-of-process (CLI `doctor`): fetches /health and reads the
 *    `event_loop` block the daemon publishes. An unreachable daemon or a
 *    build without the block reports inconclusive — this check did NOT
 *    verify the loop is healthy and must not render as if it had
 *    (catch-must-not-report-healthy discipline).
 *
 * Cold-start guard: a window younger than MIN_WINDOW_AGE_MS is
 * inconclusive, not GREEN — 30s of samples says nothing about a daemon
 * that stalls every few minutes.
 */
export const P99_ALARM_MS = 1_000;
/**
 * Separate alarm on the WORST single delay. monitorEventLoopDelay records
 * one histogram sample per stall regardless of its length — over a mature
 * 15-min window (~45k samples at 20ms resolution) a single catastrophic
 * 219s stall is ~0.002% of samples and moves p99 not at all. p99 catches
 * FREQUENT moderate lag; max catches the rare-but-severe incident class
 * that actually got the daemon killed on 2026-07-15. 5s (vs p99's 1s)
 * because a single one-off ~1s GC pause is normal life on Node, but any
 * single 5s+ block already ate half the watchdog's 10s probe timeout.
 */
export const MAX_ALARM_MS = 5_000;
export const MIN_WINDOW_AGE_MS = 60_000;

function verdict(snap: EventLoopLagSnapshot, source: string, now: number): CheckResult {
  const windowAgeMs = now - snap.windowStartedAt;
  if (windowAgeMs < MIN_WINDOW_AGE_MS) {
    return {
      ok: true,
      inconclusive: true,
      message: `event loop lag: window only ${Math.round(windowAgeMs / 1000)}s old (${source}) — too fresh to judge; p99 so far ${snap.p99Ms}ms`,
    };
  }
  if (snap.p99Ms > P99_ALARM_MS || snap.maxMs > MAX_ALARM_MS) {
    const trigger =
      snap.p99Ms > P99_ALARM_MS
        ? `p99 ${snap.p99Ms}ms exceeds ${P99_ALARM_MS}ms`
        : `worst single stall ${snap.maxMs}ms exceeds ${MAX_ALARM_MS}ms`;
    return {
      ok: false,
      message:
        `event loop lag: ${trigger} (p99 ${snap.p99Ms}ms, mean ${snap.meanMs}ms, max ${snap.maxMs}ms) over the last ` +
        `${Math.round(windowAgeMs / 60_000)}min (${source}) — something synchronous is ` +
        `starving the loop; /recall, /health and MCP all queue behind it, and past ~10s the watchdog starts killing.`,
      fix:
        'Find the synchronous work: recent additions to job handlers, unyielded scans, sync sqlite calls on big ' +
        'tables (see ADR-019). daemon.live.log timestamp gaps bracket the stalls.',
    };
  }
  return {
    ok: true,
    message: `event loop lag: p99 ${snap.p99Ms}ms (mean ${snap.meanMs}ms, max ${snap.maxMs}ms) over the last ${Math.round(windowAgeMs / 60_000)}min (${source})`,
  };
}

export function checkEventLoopLag(
  port: number,
  monitor?: EventLoopLagMonitor,
  fetchImpl: typeof fetch = fetch,
): Check {
  return {
    name: 'Event loop lag',
    tier: 'cheap', // O(1) histogram read in-process; one short local HTTP GET otherwise
    async run(): Promise<CheckResult> {
      if (monitor) {
        // Read THEN reset: the window is owned by this scheduled read, not
        // by an independent wall-clock timer. serve.ts used to reset on its
        // own 15-min setInterval started moments before the frequent-doctor
        // schedule (same period) — the doctor tick then always fired a
        // near-constant few ms AFTER the reset, so every scheduled read saw
        // a seconds-old window and the MIN_WINDOW_AGE_MS guard reported
        // inconclusive forever (found in review; the exact
        // built-wired-never-invoked class this repo documents). Resetting
        // here instead guarantees each scheduled read sees a full
        // doctor-cadence window, and the next window starts now.
        const result = verdict(monitor.snapshot(), 'in-process', Date.now());
        monitor.reset();
        return result;
      }
      try {
        // Short timeout: this is a loopback GET against an always-cached
        // /health; 1.5s is generous. Keeping it tight also keeps the cheap
        // doctor tier cheap in the no-daemon case (CLI doctor, tests) —
        // the in-process monitor path (scheduled runs) never fetches.
        const res = await fetchImpl(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1_500) });
        if (!res.ok) {
          return { ok: true, inconclusive: true, message: `event loop lag: /health answered ${res.status} — could not read event_loop block` };
        }
        const body = (await res.json()) as { event_loop?: EventLoopLagSnapshot };
        if (!body.event_loop) {
          return { ok: true, inconclusive: true, message: 'event loop lag: daemon /health has no event_loop block (older build?) — not measured' };
        }
        return verdict(body.event_loop, 'via /health', Date.now());
      } catch (err) {
        return { ok: true, inconclusive: true, message: `event loop lag: daemon not reachable to read event_loop (${err}) — not measured` };
      }
    },
  };
}
