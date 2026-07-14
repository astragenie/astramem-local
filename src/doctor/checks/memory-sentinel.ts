import type { Check, CheckResult } from '../types.js';

// ─── Check: Memory-leak sentinel (FEAT-494) ──────────────────────────────────

/**
 * Least-squares RSS growth canary for the always-on daemon. Design
 * independently reimplemented from the shape studied in Screenpipe's
 * resource monitor (study only — no code reuse; thresholds below are our own,
 * picked empirically, not ported).
 *
 * How samples accumulate: this check has no dedicated timer of its own. Its
 * own `run()` records ONE (uptimeMs, rssBytes) sample into a module-level
 * ring as a side effect, every time it runs, and fits a line against
 * whatever the ring holds so far. Because `src/doctor/schedule.ts`'s
 * `startFrequentDoctorSchedule` already invokes every `tier: 'cheap'` check
 * (this one included) every `FREQUENT_DOCTOR_INTERVAL_MS` (15 min) for the
 * lifetime of the daemon process, that existing schedule doubles as the
 * sampler's cadence — no second timer, no wiring into serve.ts, no new
 * dependency. A standalone `astramem doctor` CLI invocation is a fresh
 * process each time (empty ring, near-zero uptime) and will correctly report
 * "not enough data yet" every time; the multi-hour trend only accumulates
 * inside the long-running daemon, which is the only place a leak trend is
 * meaningful anyway (a process restart resets both the metric and the
 * problem it would be reporting).
 *
 * Storage choice — in-memory ring, not a SQLite table: deliberate.
 *  1. The metric is scoped to ONE continuous process lifetime by definition —
 *     a restart legitimately resets the growth trend along with the process,
 *     so there is nothing worth persisting across restarts in the first
 *     place (unlike e.g. crash-loop's exit-history.jsonl, which specifically
 *     needs to survive the restart it's counting).
 *  2. A capped array of ~700 `{uptimeMs, rssBytes}` pairs (two numbers each)
 *     is a trivial, fixed-size allocation — no migration, no write-path
 *     overhead added to a check that must stay cheap enough for a 15-minute
 *     unattended loop forever (see types.ts's `tier` doc comment).
 *  3. Using `opts.samples` as a direct override (see `MemorySentinelOpts`
 *     below) lets tests exercise the fit against a synthetic series without
 *     touching real process state OR needing a DB fixture at all.
 *
 * Least-squares fit + gating: fits a line to (uptimeMs, rssBytes) over the
 * post-warmup portion of the ring, then WARNs only when EVERY one of five
 * independent conditions holds together — this is deliberately harder to
 * trip than any single statistic, matching the FEAT's "avoid both false
 * positives from spiky samples and false negatives from noisy short windows"
 * bar (the same rigor `checkUsefulnessFeedbackLoop` applies to a different
 * metric):
 *   - slope (bytes/hour) at/above `slopeThresholdBytesPerHour`
 *   - fit quality (R²) at/above `minR2` — separates a real monotonic climb
 *     from a spiky-but-flat series (GC sawtooth, periodic batch jobs) that
 *     can show a nonzero slope by chance
 *   - total fitted growth across the window at/above `minFittedGrowthBytes`
 *   - current (most recent sample) RSS at/above `minAbsoluteRssBytes` — a
 *     freshly-started small daemon can show a large percentage change off a
 *     tiny base that isn't yet worth an operator's attention
 *   - post-warmup window span at/above `minWindowHours` — a short window can
 *     show a "sustained" trend on a spiky series in either direction purely
 *     by chance; this is a floor independent of R² specifically because a
 *     handful of points can produce a deceptively clean fit
 *
 * Warmup exclusion: the first `warmupMs` (default 30 min, per the FEAT) of a
 * process's life includes model/cache warmup allocation — a real, one-time
 * step change, not a sustained trend — and fitting a line across it produces
 * a spuriously high slope+R² on an otherwise perfectly healthy long-running
 * process. Samples in that window are dropped entirely before the fit runs.
 */

export interface MemorySample {
  /** Milliseconds since process start (`process.uptime() * 1000`) at the
   *  moment this sample was taken. Used as the fit's x-axis instead of a
   *  wall-clock timestamp — process age is exactly what "warmup" and
   *  "window" both mean here, and it makes the fit immune to system clock
   *  jumps (NTP step, sleep/resume) that a `Date.now()` x-axis would not be. */
  uptimeMs: number;
  /** `process.memoryUsage().rss` in bytes at the moment this sample was
   *  taken — resident set size, the same metric the 2026-07-13 GPU/VRAM
   *  incident's postmortem flagged as the one this repo had no canary for. */
  rssBytes: number;
}

export interface MemorySentinelOpts {
  /** Injectable sample source for the module-level ring's own recording step
   *  — tests substitute a stub instead of real `process.uptime()`/
   *  `process.memoryUsage()`. Ignored entirely when `samples` is supplied.
   *  Defaults to the real process. */
  sample?: () => MemorySample;
  /** Injectable full sample series — when supplied, the check fits against
   *  EXACTLY this array and does not read or append to the module-level ring
   *  at all. This is how tests exercise flat / spiky-but-flat / genuinely-
   *  growing synthetic series deterministically, without waiting real hours
   *  or mutating shared module state. Defaults to the module-level ring
   *  (see `recordSample`/`getRingSnapshot` below). */
  samples?: MemorySample[];
  /** Max samples retained by the module-level ring before the oldest is
   *  evicted. Default 700 — at the 15-min doctor cheap-tier cadence
   *  (`FREQUENT_DOCTOR_INTERVAL_MS`, schedule.ts) that's roughly a week of
   *  history, comfortably more than `minWindowHours` ever needs, at a fixed,
   *  trivial memory cost regardless of how long the daemon has been up. */
  maxRingSamples?: number;
  /** Exclude samples with `uptimeMs` below this floor from the fit. Default
   *  30 minutes — spec-mandated (FEAT-494 acceptance hints). */
  warmupMs?: number;
  /** Minimum post-warmup sample count required before the check renders a
   *  verdict at all. Default 8 — below this a least-squares fit is honestly
   *  unstable regardless of what R² comes out to. */
  minSamples?: number;
  /** Minimum post-warmup window span, in hours, required before the check
   *  renders a verdict. Default 3 — independent of R² on purpose: a handful
   *  of points spanning a short window can still produce a deceptively clean
   *  fit by chance, and "sustained" is a claim about time, not just about
   *  fit quality. */
  minWindowHours?: number;
  /** Minimum fit quality (R², 0..1) required before growth counts as
   *  "sustained linear" rather than noise. Default 0.8 — a high bar,
   *  deliberately: a spiky-but-flat series (GC sawtooth, periodic batch
   *  jobs) can still show a moderate positive slope by chance; requiring a
   *  strong linear fit is what separates a real monotonic leak from noise
   *  riding a slight upward drift. */
  minR2?: number;
  /** Minimum fitted slope, in bytes/hour, before growth is even considered.
   *  Default 10 MiB/hour — picked as a rate that would meaningfully exhaust
   *  a typical desktop's headroom over a matter of days, not something a
   *  single allocation burst produces. */
  slopeThresholdBytesPerHour?: number;
  /** Minimum TOTAL fitted growth across the observed post-warmup window, in
   *  bytes, before WARNing. Default 50 MiB — guards against a slope that
   *  clears the per-hour threshold by a hair over a borderline window
   *  without yet amounting to a problem worth an operator's attention. */
  minFittedGrowthBytes?: number;
  /** Minimum current (most recent sample) RSS, in bytes, before WARNing.
   *  Default 150 MiB — a freshly-started small daemon can show a large
   *  percentage growth off a tiny base; this floor keeps the check quiet
   *  until the daemon is carrying meaningful resident memory in the first
   *  place. */
  minAbsoluteRssBytes?: number;
}

const MIB = 1024 * 1024;

export const MEMORY_SENTINEL_WARMUP_MS = 30 * 60 * 1000;
export const MEMORY_SENTINEL_MIN_SAMPLES = 8;
export const MEMORY_SENTINEL_MIN_WINDOW_HOURS = 3;
export const MEMORY_SENTINEL_MIN_R2 = 0.8;
export const MEMORY_SENTINEL_SLOPE_THRESHOLD_BYTES_PER_HOUR = 10 * MIB;
export const MEMORY_SENTINEL_MIN_FITTED_GROWTH_BYTES = 50 * MIB;
export const MEMORY_SENTINEL_MIN_ABSOLUTE_RSS_BYTES = 150 * MIB;
export const MEMORY_SENTINEL_MAX_RING_SAMPLES = 700;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function bytesToMb(bytes: number): string {
  return (bytes / MIB).toFixed(1);
}

function defaultSample(): MemorySample {
  return { uptimeMs: process.uptime() * 1000, rssBytes: process.memoryUsage().rss };
}

// ─── Module-level ring (see storage-choice doc comment above) ───────────────

let ring: MemorySample[] = [];

function recordSample(sample: MemorySample, maxRingSamples: number): void {
  ring.push(sample);
  if (ring.length > maxRingSamples) {
    ring = ring.slice(ring.length - maxRingSamples);
  }
}

function getRingSnapshot(): MemorySample[] {
  return ring;
}

/** Test-only reset for the module-level ring — production code never calls
 *  this. Exported so tests can isolate cases that exercise the real
 *  recording path (no `samples` override) from one another. */
export function __resetMemorySentinelRingForTests(): void {
  ring = [];
}

// ─── Least-squares fit ───────────────────────────────────────────────────────

interface LeastSquaresFit {
  /** bytes per millisecond of uptime */
  slope: number;
  intercept: number;
  /** coefficient of determination, 0..1 (0 when x or y has zero variance) */
  r2: number;
}

function leastSquares(points: { x: number; y: number }[]): LeastSquaresFit {
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.x, 0) / n;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const p of points) {
    const dx = p.x - meanX;
    const dy = p.y - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = meanY - slope * meanX;
  const r2 = sxx === 0 || syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, intercept, r2 };
}

// ─── Check ────────────────────────────────────────────────────────────────

export function checkMemorySentinel(rawOpts: MemorySentinelOpts = {}): Check {
  const warmupMs = rawOpts.warmupMs ?? MEMORY_SENTINEL_WARMUP_MS;
  const minSamples = rawOpts.minSamples ?? MEMORY_SENTINEL_MIN_SAMPLES;
  const minWindowHours = rawOpts.minWindowHours ?? MEMORY_SENTINEL_MIN_WINDOW_HOURS;
  const minR2 = rawOpts.minR2 ?? MEMORY_SENTINEL_MIN_R2;
  const slopeThresholdBytesPerHour =
    rawOpts.slopeThresholdBytesPerHour ?? MEMORY_SENTINEL_SLOPE_THRESHOLD_BYTES_PER_HOUR;
  const minFittedGrowthBytes = rawOpts.minFittedGrowthBytes ?? MEMORY_SENTINEL_MIN_FITTED_GROWTH_BYTES;
  const minAbsoluteRssBytes = rawOpts.minAbsoluteRssBytes ?? MEMORY_SENTINEL_MIN_ABSOLUTE_RSS_BYTES;
  const maxRingSamples = rawOpts.maxRingSamples ?? MEMORY_SENTINEL_MAX_RING_SAMPLES;
  const sample = rawOpts.sample ?? defaultSample;

  return {
    name: 'Memory sentinel',
    // Bounded array read + arithmetic over at most maxRingSamples points,
    // regardless of corpus size — no I/O, no scan of a growing table. Safe
    // on the 15-minute unattended interval forever (types.ts's tier doc
    // comment); this classification is also load-bearing for the sampling
    // design above, not just a cost label — the frequent schedule IS the
    // sampler's cadence, see this file's header comment.
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      let series: MemorySample[];
      if (rawOpts.samples) {
        series = rawOpts.samples;
      } else {
        let current: MemorySample;
        try {
          current = sample();
        } catch (err) {
          // The sample source itself failed — this did NOT record a data
          // point or verify anything about RSS trend, so it must not
          // render/count as if it had (same "don't let a probe failure look
          // like a clean bill of health" rule every other doctor check
          // follows — see types.ts's CheckResult.inconclusive doc comment).
          return { ok: true, inconclusive: true, message: `memory sentinel: sample source unavailable (non-fatal): ${errMsg(err)}` };
        }
        recordSample(current, maxRingSamples);
        series = getRingSnapshot();
      }

      const postWarmup = series.filter((s) => s.uptimeMs >= warmupMs);
      if (postWarmup.length < minSamples) {
        return {
          ok: true,
          message:
            `memory sentinel: not enough post-warmup samples yet (${postWarmup.length}/${minSamples}, ` +
            `warmup ${(warmupMs / 60000).toFixed(0)}min) — daemon needs to run longer before a growth trend means anything`,
        };
      }

      const first = postWarmup[0]!;
      const last = postWarmup[postWarmup.length - 1]!;
      const windowHours = (last.uptimeMs - first.uptimeMs) / 3_600_000;
      if (windowHours < minWindowHours) {
        return {
          ok: true,
          message:
            `memory sentinel: post-warmup window too short yet (${windowHours.toFixed(2)}h / ${minWindowHours}h ` +
            `needed, ${postWarmup.length} samples)`,
        };
      }

      const { slope, r2 } = leastSquares(postWarmup.map((s) => ({ x: s.uptimeMs, y: s.rssBytes })));
      const slopeBytesPerHour = slope * 3_600_000;
      const fittedGrowthBytes = slope * (last.uptimeMs - first.uptimeMs);
      const currentRssBytes = last.rssBytes;

      const sustained =
        slopeBytesPerHour >= slopeThresholdBytesPerHour &&
        r2 >= minR2 &&
        fittedGrowthBytes >= minFittedGrowthBytes &&
        currentRssBytes >= minAbsoluteRssBytes;

      const summary =
        `slope ${bytesToMb(slopeBytesPerHour)} MB/h, r²=${r2.toFixed(2)}, fitted growth ${bytesToMb(fittedGrowthBytes)} MB ` +
        `over ${windowHours.toFixed(1)}h (${postWarmup.length} post-warmup samples), current RSS ${bytesToMb(currentRssBytes)} MB`;

      if (sustained) {
        return {
          ok: false,
          message: `memory sentinel: sustained linear RSS growth detected — ${summary}`,
          fix:
            'Slope, fit quality, total growth, and absolute RSS all cleared their thresholds together — this is ' +
            'unlikely to be noise. Capture a heap snapshot before restarting if possible, then restart the daemon ' +
            'to reclaim; check for a recently added native add-on or an unbounded in-process cache as the source ' +
            '(e.g. FEAT-489 audio adds native add-on memory pressure).',
        };
      }

      return { ok: true, message: `memory sentinel: no sustained growth — ${summary}` };
    },
  };
}
