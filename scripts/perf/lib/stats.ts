/** Percentile helpers for the perf harness — no dependency. */

export interface LatencyStats {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile over a sorted-ascending copy of `samples`. */
export function summarize(samplesMs: number[]): LatencyStats {
  if (samplesMs.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const pct = (p: number): number => {
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)] as number;
  };
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return {
    n: sorted.length,
    p50: pct(50),
    p95: pct(95),
    max: sorted[sorted.length - 1] as number,
    mean,
  };
}

/** Run `fn` `warmup + iterations` times, discard the first `warmup` timings,
 *  return latency stats over the rest. */
export async function timeIterations(
  fn: () => Promise<unknown>,
  opts: { iterations: number; warmup: number },
): Promise<LatencyStats> {
  const samples: number[] = [];
  const total = opts.warmup + opts.iterations;
  for (let i = 0; i < total; i++) {
    const t0 = performance.now();
    await fn();
    const ms = performance.now() - t0;
    if (i >= opts.warmup) samples.push(ms);
  }
  return summarize(samples);
}
