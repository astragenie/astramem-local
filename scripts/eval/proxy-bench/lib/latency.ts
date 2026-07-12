/**
 * Latency sample collection + percentile summary for the proxy bench
 * (FEAT-458 W1a, S1-AC-3). `summarizeExtended` deliberately REUSES
 * ../../../perf/lib/stats.ts's `summarize` for n/p50/p95/max/mean — that is
 * the repo's one existing nearest-rank percentile implementation (see
 * scripts/perf/bench.mts) and this harness must not grow a second,
 * potentially-drifting copy of the same math. The only genuinely new bit is
 * p99 (S2-AC-4 cites the p50 delta, but p99 is useful context for tail
 * overhead and ../../../perf/lib/stats.ts's `LatencyStats` shape doesn't
 * carry it) plus `min`, computed with the identical nearest-rank formula
 * `summarize` uses internally so the two percentile points stay consistent
 * with each other.
 */
import { summarize } from '../../../perf/lib/stats.js';
import { mapWithConcurrency } from '../../shared/concurrency.js';

export interface ExtendedLatencyStats {
  n: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Retained for JSON output / re-derivation, same precedent as
   *  ../../shared/stats.ts's `Stats.raw`. */
  raw: number[];
}

/** Mirrors the nearest-rank formula summarize() uses internally for p50/p95
 *  (scripts/perf/lib/stats.ts) — kept local only because that function
 *  doesn't expose a standalone per-percentile helper, not a competing
 *  algorithm. */
function nearestRank(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)] as number;
}

export function summarizeExtended(samplesMs: number[]): ExtendedLatencyStats {
  const base = summarize(samplesMs);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    n: base.n,
    min: sorted.length > 0 ? (sorted[0] as number) : 0,
    p50: base.p50,
    p95: base.p95,
    p99: nearestRank(sorted, 99),
    max: base.max,
    mean: base.mean,
    raw: samplesMs,
  };
}

export interface CollectLatenciesOpts {
  iterations: number;
  warmup: number;
  /** Requests in flight at once. Default 1 (strictly sequential) — the
   *  canonical S1-AC-3 measurement wants per-request latency, not
   *  queueing delay under concurrent load. With concurrency=1,
   *  mapWithConcurrency's single worker processes items in order, which is
   *  exactly equivalent to a sequential for-loop (same semantics as
   *  ../../../perf/lib/stats.ts's timeIterations). Values >1 are supported
   *  for throughput-flavoured runs but the discarded "warmup" prefix then
   *  refers to array index, not wall-clock arrival order. */
  concurrency?: number;
}

/**
 * Run `fn` `warmup + iterations` times, time each call with
 * `performance.now()`, discard the first `warmup` timings by index, return
 * the raw per-request millisecond samples (not yet summarized — callers
 * combine two distributions, e.g. direct vs. proxied, before deciding what
 * to summarize). Deterministic given a deterministic `fn` — no jitter or
 * randomness introduced here.
 */
export async function collectLatencies(
  fn: () => Promise<unknown>,
  opts: CollectLatenciesOpts,
): Promise<number[]> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const total = opts.warmup + opts.iterations;
  const timings: number[] = new Array(total);
  await mapWithConcurrency(Array.from({ length: total }, (_, i) => i), concurrency, async (i) => {
    const t0 = performance.now();
    await fn();
    timings[i] = performance.now() - t0;
  });
  return timings.slice(opts.warmup);
}

export interface OverheadDelta {
  p50: number;
  p95: number;
  p99: number;
  mean: number;
}

/** proxied - direct, per percentile — the number S2-AC-4 asserts p50 is
 *  under 10ms for. */
export function computeOverhead(direct: ExtendedLatencyStats, proxied: ExtendedLatencyStats): OverheadDelta {
  return {
    p50: proxied.p50 - direct.p50,
    p95: proxied.p95 - direct.p95,
    p99: proxied.p99 - direct.p99,
    mean: proxied.mean - direct.mean,
  };
}
