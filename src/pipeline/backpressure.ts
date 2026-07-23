/**
 * backpressure.ts — adaptive worker-load governor (stabilization plan
 * P1.4 + P1.5).
 *
 * 2026-07-15 incident inputs this closes:
 *  - embed-heavy jobs (distill/reembed) kept claiming at full concurrency
 *    while the embed provider was saturated (measured 62–142s per embed) —
 *    every lane just deepened the provider's queue;
 *  - retries used a deterministic exponential backoff with NO jitter, so a
 *    wave of jobs failing at the same saturation moment retried in
 *    lockstep ("fetch failed" storms re-amplifying the load);
 *  - a restart re-enqueued orphans and consolidate at boot and the worker
 *    claimed them at full concurrency at the exact moment the daemon was
 *    trying to prove liveness to the watchdog.
 *
 * One object owns the lane budget; two signals drive it:
 *  1. Embed-heavy handler latency EWMA → staircase multiplier (1 → ½ → ¼).
 *  2. Boot ramp — lanes start at 1 and step up to full over rampStepMs
 *     intervals ("serve traffic first, catch up second" — the job-queue
 *     analog of the embed prober's degraded-start philosophy).
 * The governor also owns retry shaping: always-positive jitter (never
 * undercuts a Retry-After floor) plus an aggregate retry-rate clamp that
 * pushes ALL retry delays up when the system-wide retry rate storms.
 *
 * Everything here is pure in-memory arithmetic — no I/O, nothing to leak.
 * Failure posture: malformed/NaN inputs always degrade toward "assume
 * normal" (multiplier 1, no clamp), never toward max-throttle — mirrors
 * resolveWorkerConcurrency's "malformed config never blocks boot".
 */

/** Handler kinds whose latency feeds the EWMA — the embed/LLM-bound ones. */
export const EMBED_HEAVY_KINDS = new Set(['distill', 'reembed']);

/**
 * FEAT-482 fold (worker-starvation wave, item 2 of 3): the lane index
 * `worker.ts` reserves for preferential local-sqlite-kind claims
 * (`job-repo.ts`'s `LOCAL_SQLITE_KINDS`). MUST be 0 — `laneBudget()` above
 * gates lane 0 always-on (`Math.max(1, ...)`; the `laneId >= laneBudget()`
 * skip check in `worker.ts` can never be true for lane 0), so lane 0 is the
 * one lane that keeps running even when the embed-latency EWMA throttles
 * every other lane to zero. An arbitrary/higher lane index would itself get
 * throttled during the exact saturation event the local/network split
 * exists to survive, defeating the point of reserving it.
 */
export const RESERVED_LOCAL_LANE_ID = 0;

export const DEFAULT_SLOW_THRESHOLD_MS = 5_000;
export const DEFAULT_SEVERE_THRESHOLD_MS = 20_000;
export const DEFAULT_RETRY_BUDGET_PER_MIN = 20;
export const DEFAULT_BOOT_RAMP_STEP_MS = 60_000;
/** Floor applied to every retry delay while the aggregate retry rate is
 *  over budget — spreads a storm out instead of letting the 1/2/4s
 *  exponential re-slam a saturated provider. */
export const RETRY_STORM_FLOOR_MS = 30_000;
/** Max positive jitter fraction added to retry delays. Positive-only so a
 *  server-supplied Retry-After floor is never undercut. */
export const RETRY_JITTER_MAX_FRACTION = 0.3;

const EWMA_ALPHA = 0.3;
const EWMA_SEED_MS = 1_000;
const RETRY_WINDOW_MS = 60_000;

export interface LoadGovernorOpts {
  /** Full lane count (resolveWorkerConcurrency's result). */
  maxLanes: number;
  slowThresholdMs?: number;
  severeThresholdMs?: number;
  retryBudgetPerMin?: number;
  /** Omit to disable the boot ramp (lanes start at full — test/CLI use). */
  bootRamp?: { rampStepMs?: number };
  /** Injectable clock/random for tests. */
  now?: () => number;
  random?: () => number;
}

export interface LoadGovernor {
  /** How many lanes may claim jobs right now (>= 1 always). */
  laneBudget(): number;
  /** Feed a completed/failed handler run; non-embed-heavy kinds are ignored. */
  recordHandlerRun(kind: string, durationMs: number): void;
  /** Feed one retry event (any kind) into the aggregate rate window. */
  recordRetry(): void;
  /** Shape a computed retry delay: storm floor clamp + positive jitter. */
  shapeRetryDelay(delayMs: number): number;
  /** Current embed-latency EWMA — observability (dashboard, /health later). */
  ewmaMs(): number;
  /** Stop ramp timers. Idempotent. */
  stop(): void;
}

export function createLoadGovernor(opts: LoadGovernorOpts): LoadGovernor {
  const maxLanes = Math.max(1, Math.trunc(opts.maxLanes) || 1);
  const slowMs = opts.slowThresholdMs ?? DEFAULT_SLOW_THRESHOLD_MS;
  const severeMs = opts.severeThresholdMs ?? DEFAULT_SEVERE_THRESHOLD_MS;
  const retryBudgetPerMin = opts.retryBudgetPerMin ?? DEFAULT_RETRY_BUDGET_PER_MIN;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;

  let ewma = EWMA_SEED_MS;
  const retryTimestamps: number[] = [];

  // Boot ramp: 1 → ceil(max/2) → max. With maxLanes 1 or 2 the middle step
  // collapses naturally (dedup below).
  const rampLevels = [...new Set([1, Math.ceil(maxLanes / 2), maxLanes])].sort((a, b) => a - b);
  let rampIndex = opts.bootRamp ? 0 : rampLevels.length - 1;
  let rampTimer: ReturnType<typeof setInterval> | null = null;
  if (opts.bootRamp && rampLevels.length > 1) {
    const stepMs = opts.bootRamp.rampStepMs ?? DEFAULT_BOOT_RAMP_STEP_MS;
    rampTimer = setInterval(() => {
      rampIndex = Math.min(rampIndex + 1, rampLevels.length - 1);
      if (rampIndex === rampLevels.length - 1 && rampTimer) {
        clearInterval(rampTimer);
        rampTimer = null;
      }
    }, stepMs);
    rampTimer.unref?.();
  }

  function latencyMultiplier(): number {
    if (!Number.isFinite(ewma)) return 1; // assume normal, never max-throttle
    if (ewma > severeMs) return 0.25;
    if (ewma > slowMs) return 0.5;
    return 1;
  }

  function pruneRetryWindow(nowMs: number): void {
    const cutoff = nowMs - RETRY_WINDOW_MS;
    while (retryTimestamps.length > 0 && retryTimestamps[0]! < cutoff) retryTimestamps.shift();
  }

  return {
    laneBudget(): number {
      const rampCap = rampLevels[rampIndex]!;
      const latencyCap = Math.round(maxLanes * latencyMultiplier());
      // A budget below 1 would deadlock the queue outright — the goal is
      // "slower", never "stopped".
      return Math.max(1, Math.min(rampCap, latencyCap));
    },
    recordHandlerRun(kind: string, durationMs: number): void {
      if (!EMBED_HEAVY_KINDS.has(kind)) return;
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      ewma = EWMA_ALPHA * durationMs + (1 - EWMA_ALPHA) * ewma;
    },
    recordRetry(): void {
      const t = now();
      retryTimestamps.push(t);
      pruneRetryWindow(t);
    },
    shapeRetryDelay(delayMs: number): number {
      const base = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 1_000;
      pruneRetryWindow(now());
      const storming = retryTimestamps.length > retryBudgetPerMin;
      const floored = storming ? Math.max(base, RETRY_STORM_FLOOR_MS) : base;
      // Positive-only jitter: [floored, floored * 1.3]. Never shrinks the
      // delay, so Retry-After floors and the exponential minimum both hold.
      return Math.round(floored * (1 + RETRY_JITTER_MAX_FRACTION * random()));
    },
    ewmaMs(): number {
      return Math.round(ewma);
    },
    stop(): void {
      if (rampTimer) {
        clearInterval(rampTimer);
        rampTimer = null;
      }
    },
  };
}
