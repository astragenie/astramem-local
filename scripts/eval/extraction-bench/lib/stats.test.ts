import { describe, it, expect } from 'vitest';
import { mean, sampleStdev, computeStats, compareMeans, formatStatsPct, type Stats } from './stats.js';

describe('mean', () => {
  it('averages finite numbers', () => {
    expect(mean([1, 2, 3])).toBe(2);
  });
  it('ignores non-finite values', () => {
    expect(mean([1, NaN, 3, Infinity])).toBe(2);
  });
  it('returns null for an empty/all-non-finite array', () => {
    expect(mean([])).toBeNull();
    expect(mean([NaN, Infinity])).toBeNull();
  });
});

describe('sampleStdev', () => {
  it('returns null with fewer than 2 finite values (no variance estimate)', () => {
    expect(sampleStdev([])).toBeNull();
    expect(sampleStdev([5])).toBeNull();
    expect(sampleStdev([5, NaN])).toBeNull();
  });
  it('matches the known sample stdev of a simple series', () => {
    // 2,4,4,4,5,5,7,9 -> sample stdev = 2.13809...(textbook example)
    const s = sampleStdev([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(s).not.toBeNull();
    expect(s as number).toBeCloseTo(2.1381, 3);
  });
  it('is 0 for identical values', () => {
    expect(sampleStdev([0.5, 0.5, 0.5])).toBe(0);
  });
});

describe('computeStats', () => {
  it('bundles mean/stdev/n/raw and drops non-finite entries', () => {
    const s = computeStats([0.5, 0.6, NaN, 0.7]);
    expect(s.n).toBe(3);
    expect(s.raw).toEqual([0.5, 0.6, 0.7]);
    expect(s.mean).toBeCloseTo(0.6, 10);
    expect(s.stdev).not.toBeNull();
  });
  it('single value: mean set, stdev null, n=1', () => {
    const s = computeStats([0.42]);
    expect(s.mean).toBe(0.42);
    expect(s.stdev).toBeNull();
    expect(s.n).toBe(1);
  });
});

describe('formatStatsPct', () => {
  it('renders mean ± stdev as percentages when stdev is available', () => {
    const s: Stats = { mean: 0.57, stdev: 0.04, n: 3, raw: [0.53, 0.57, 0.61] };
    expect(formatStatsPct(s)).toBe('57% ± 4%');
  });
  it('renders a bare percentage when stdev is unavailable (n=1)', () => {
    const s: Stats = { mean: 0.5, stdev: null, n: 1, raw: [0.5] };
    expect(formatStatsPct(s)).toBe('50%');
  });
  it('renders an em-dash for null/undefined stats', () => {
    expect(formatStatsPct(null)).toBe('—');
    expect(formatStatsPct(undefined)).toBe('—');
    expect(formatStatsPct({ mean: null, stdev: null, n: 0, raw: [] })).toBe('—');
  });
});

describe('compareMeans — AC-2 significance gate', () => {
  it('labels a delta smaller than the noise floor "within noise / not significant"', () => {
    // Two configs whose per-run F1 samples heavily overlap (this mirrors
    // the FEAT-450 triage-note evidence: qwen2.5:7b F1 50/53/58/59/61/61/67/72
    // across near-identical configs — huge stdev, small between-config delta).
    const a = computeStats([0.50, 0.58, 0.61, 0.67]); // mean ~0.59
    const b = computeStats([0.53, 0.59, 0.61, 0.72]); // mean ~0.6125
    const cmp = compareMeans(a, b);
    expect(cmp.label).toBe('within noise / not significant');
    expect(cmp.significant).toBe(false);
  });

  it('labels a delta larger than the noise floor "significant"', () => {
    // Low-variance, clearly separated configs (e.g. a big cloud model vs a
    // small local one — the FEAT-450 note's azure=81 vs local ~50-72 band).
    const a = computeStats([0.80, 0.81, 0.82, 0.81]); // tight, mean ~0.81
    const b = computeStats([0.50, 0.51, 0.49, 0.50]); // tight, mean ~0.50
    const cmp = compareMeans(a, b);
    expect(cmp.label).toBe('significant');
    expect(cmp.significant).toBe(true);
    expect(cmp.delta).toBeGreaterThan(0);
  });

  it('reports "insufficient data" when either side has fewer than 2 runs', () => {
    const single = computeStats([0.6]);
    const multi = computeStats([0.5, 0.55, 0.6]);
    expect(compareMeans(single, multi).label).toBe('insufficient data');
    expect(compareMeans(multi, single).label).toBe('insufficient data');
    expect(compareMeans(single, single).label).toBe('insufficient data');
    expect(Number.isNaN(compareMeans(single, multi).noiseFloor)).toBe(true);
  });

  it('is symmetric in magnitude (|delta| same, sign flips) when arguments are swapped', () => {
    const a = computeStats([0.80, 0.82, 0.81]);
    const b = computeStats([0.50, 0.52, 0.51]);
    const ab = compareMeans(a, b);
    const ba = compareMeans(b, a);
    expect(ab.delta).toBeCloseTo(-ba.delta, 10);
    expect(ab.noiseFloor).toBeCloseTo(ba.noiseFloor, 10);
    expect(ab.significant).toBe(ba.significant);
  });

  it('tightens the noise floor as more runs are collected (same stdev, larger n)', () => {
    // Same underlying spread, but one comparison has more runs backing it —
    // the SE-based floor should shrink, making the same delta easier to
    // call significant with more evidence.
    const aFew = computeStats([0.55, 0.65]); // n=2
    const bFew = computeStats([0.45, 0.55]); // n=2
    const aMany = computeStats([0.55, 0.65, 0.55, 0.65, 0.55, 0.65]); // n=6, same mean/spread pattern
    const bMany = computeStats([0.45, 0.55, 0.45, 0.55, 0.45, 0.55]); // n=6
    const few = compareMeans(aFew, bFew);
    const many = compareMeans(aMany, bMany);
    expect(many.noiseFloor).toBeLessThan(few.noiseFloor);
  });
});
