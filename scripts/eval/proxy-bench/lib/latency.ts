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

/**
 * proxied - direct overhead, computed **per-request-pair** — the number
 * S2-AC-4 / S4-AC-2 assert p50 is under 10ms for.
 *
 * FEAT-458-S1-design.md §3.2 pins this explicitly and warns against the
 * mistake this function previously made: subtracting `proxied.p50 -
 * direct.p50` (two INDEPENDENTLY-computed aggregate percentiles) is not the
 * same statistic as the p50 of the per-request deltas whenever the two
 * distributions aren't perfectly rank-correlated — e.g. direct=[1,2,3,4,5],
 * proxied=[100,2,3,4,5] (only request 0 sees a 99ms outlier): the aggregate
 * method reports a 1ms p50 "systemic" overhead (direct's p50=3,
 * proxied's p50=4) that no single request actually experienced, while the
 * per-pair delta [99,0,0,0,0] correctly reports a 0ms p50 overhead with one
 * outlier visible only at p95/p99 (see the regression test in
 * latency.test.ts using exactly this series). The S2 review that first
 * flagged this bug found it didn't change that slice's PASS verdict (margin
 * was ~29x — 0.34ms vs. a 10ms threshold) but S4b's capture-live margin is
 * expected to be tighter, so the aggregate/per-pair distinction now matters
 * for the number itself, not just its correctness in principle.
 *
 * Requires `direct` and `proxied` to carry the same number of samples,
 * index-aligned — true for every caller in this harness because both legs
 * always run with the same `iterations`/`warmup` config (bench.mts), so
 * request i of one leg and request i of the other are the "pair" the design
 * doc means (not concurrency-paired, index-paired).
 */
export function computeOverhead(direct: ExtendedLatencyStats, proxied: ExtendedLatencyStats): OverheadDelta {
  if (direct.raw.length !== proxied.raw.length) {
    throw new Error(
      `computeOverhead requires index-aligned equal-length samples (direct n=${direct.raw.length}, proxied n=${proxied.raw.length}) ` +
      '— per-request-pair delta is undefined otherwise (FEAT-458-S1-design.md §3.2)',
    );
  }
  const deltas = direct.raw.map((d, i) => (proxied.raw[i] as number) - d);
  const sorted = [...deltas].sort((a, b) => a - b);
  const mean = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;
  return {
    p50: nearestRank(sorted, 50),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    mean,
  };
}
