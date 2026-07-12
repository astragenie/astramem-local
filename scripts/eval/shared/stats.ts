/**
 * Pure statistics helpers for multi-run bench aggregation. Originated in
 * extraction-bench (FEAT-450); promoted here (FEAT-457 slice 1, AC-4) so
 * locomo's judge layer can reuse the identical mean/stdev/formatting math
 * instead of a duplicate implementation — extraction-bench now imports this
 * same file rather than keeping its own copy.
 *
 * No I/O, no Azure/Ollama dependency — everything here is testable with
 * synthetic arrays, which is how stats.test.ts exercises it.
 */

/** Arithmetic mean of the finite values in `nums`; null if there are none. */
export function mean(nums: number[]): number | null {
  const finite = nums.filter(n => Number.isFinite(n));
  return finite.length > 0 ? finite.reduce((a, b) => a + b, 0) / finite.length : null;
}

/**
 * Sample standard deviation (n-1 denominator — Bessel's correction; these
 * runs are a sample of the config's noise distribution, not the whole
 * population of possible runs). Requires >=2 finite values; null otherwise
 * (a single run has no variance estimate, by definition).
 */
export function sampleStdev(nums: number[]): number | null {
  const finite = nums.filter(n => Number.isFinite(n));
  if (finite.length < 2) return null;
  const m = mean(finite);
  if (m === null) return null;
  const variance = finite.reduce((acc, x) => acc + (x - m) ** 2, 0) / (finite.length - 1);
  return Math.sqrt(variance);
}

export interface Stats {
  mean: number | null;
  stdev: number | null;
  /** Count of finite values that went into mean/stdev. */
  n: number;
  /** The finite values themselves, retained for inspection/re-derivation. */
  raw: number[];
}

/** Compute {mean, stdev, n, raw} from a list of per-run values in one call. */
export function computeStats(nums: number[]): Stats {
  const finite = nums.filter(n => Number.isFinite(n));
  return { mean: mean(finite), stdev: sampleStdev(finite), n: finite.length, raw: finite };
}

/** Format a Stats as "57% ± 4%" (or a bare "57%" when stdev is unavailable). */
export function formatStatsPct(s: Stats | null | undefined): string {
  if (!s || s.mean === null) return '—';
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  return s.stdev === null ? pct(s.mean) : `${pct(s.mean)} ± ${pct(s.stdev)}`;
}

export type SignificanceLabel = 'significant' | 'within noise / not significant' | 'insufficient data';

export interface SignificanceResult {
  /** meanA - meanB (signed; positive means A scored higher). */
  delta: number;
  /** The computed noise floor the delta was compared against. NaN when insufficient data. */
  noiseFloor: number;
  significant: boolean;
  label: SignificanceLabel;
}

/**
 * AC-2 significance gate: decide whether two configs' mean metric (e.g. F1)
 * differ by more than can be explained by run-to-run noise.
 *
 * Noise floor = k * standard-error-of-the-difference, i.e.
 *   k * sqrt(stdevA^2/nA + stdevB^2/nB)
 * which is the standard two-sample comparison (k=2 approximates a ~95% CI
 * on the difference under a normal approximation — the FEAT spec's own
 * suggested "~2x" ballpark, but computed from each side's *actual* n rather
 * than a flat pooled-stdev multiplier, so it tightens automatically as more
 * runs are collected). Requires >=2 runs (a stdev) on BOTH sides; with only
 * one run per side there is no noise estimate to gate on, so the comparison
 * is honestly reported as "insufficient data" rather than silently ranked.
 */
export function compareMeans(a: Stats, b: Stats, k = 2): SignificanceResult {
  if (a.mean === null || b.mean === null || a.stdev === null || b.stdev === null || a.n < 2 || b.n < 2) {
    return { delta: (a.mean ?? 0) - (b.mean ?? 0), noiseFloor: NaN, significant: false, label: 'insufficient data' };
  }
  const seDiff = Math.sqrt((a.stdev ** 2) / a.n + (b.stdev ** 2) / b.n);
  const noiseFloor = k * seDiff;
  const delta = a.mean - b.mean;
  const significant = Math.abs(delta) > noiseFloor;
  return { delta, noiseFloor, significant, label: significant ? 'significant' : 'within noise / not significant' };
}
