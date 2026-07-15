/**
 * event-loop-lag.ts — event-loop delay observer (stabilization plan P1.2).
 *
 * The 2026-07-15 incident's defining property was INVISIBILITY: the event
 * loop stalled 15–219s during embed-heavy background jobs, /health timed
 * out, the watchdog killed the daemon — and nothing in /health, doctor, or
 * the logs measured the stall itself. A human discovered it by curling
 * /version by hand and timing it. This module makes loop lag a first-class,
 * always-on measurement.
 *
 * Wraps perf_hooks.monitorEventLoopDelay (a native histogram — sampling and
 * reads are O(1) and never themselves touch the loop, which is the property
 * that makes this canary readable DURING the exact stall it exists to
 * report). Reset on a fixed window cadence by the caller (serve.ts ties it
 * to the frequent-doctor 15-min tick) so percentiles describe the recent
 * window, not the whole daemon lifetime — a boot-time stall must not
 * dominate p99 forever, and a fresh stall must not be diluted by days of
 * healthy samples.
 *
 * Per the canary-rate rule (ADR-015 / CLAUDE.md): consumers report the
 * NUMBERS (p99/mean/max), never a boolean.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';

/** Histogram sampling resolution. 20ms keeps overhead negligible while
 *  resolving the >=1s stalls the doctor check alarms on with 50x headroom. */
const RESOLUTION_MS = 20;

export interface EventLoopLagSnapshot {
  /** 99th-percentile loop delay in ms over the current window. */
  p99Ms: number;
  /** Mean loop delay in ms over the current window. */
  meanMs: number;
  /** Worst single delay in ms over the current window. */
  maxMs: number;
  /** Epoch ms when the current window started (last reset / enable). */
  windowStartedAt: number;
}

export interface EventLoopLagMonitor {
  snapshot(): EventLoopLagSnapshot;
  /** Start a fresh window: clears the histogram, restamps windowStartedAt. */
  reset(): void;
  /** Stop sampling (shutdown). Idempotent. */
  disable(): void;
}

/** Minimal structural seam so tests can inject a fake histogram with
 *  controlled percentiles instead of loading the real loop. Matches the
 *  subset of IntervalHistogram this module reads. */
export interface HistogramLike {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(p: number): number; // nanoseconds
  mean: number; // nanoseconds
  max: number; // nanoseconds
}

const NS_PER_MS = 1e6;

/** NaN-safe ns→ms: an empty histogram reads NaN mean on some Node versions;
 *  report 0 ("no samples yet"), never NaN (which would JSON-serialize to
 *  null and break numeric consumers silently). */
function nsToMs(ns: number): number {
  return Number.isFinite(ns) ? ns / NS_PER_MS : 0;
}

export function createEventLoopLagMonitor(
  histogram: HistogramLike = monitorEventLoopDelay({ resolution: RESOLUTION_MS }),
  now: () => number = Date.now,
): EventLoopLagMonitor {
  histogram.enable();
  let windowStartedAt = now();

  return {
    snapshot(): EventLoopLagSnapshot {
      return {
        p99Ms: Math.round(nsToMs(histogram.percentile(99)) * 10) / 10,
        meanMs: Math.round(nsToMs(histogram.mean) * 10) / 10,
        maxMs: Math.round(nsToMs(histogram.max) * 10) / 10,
        windowStartedAt,
      };
    },
    reset(): void {
      histogram.reset();
      windowStartedAt = now();
    },
    disable(): void {
      histogram.disable();
    },
  };
}
