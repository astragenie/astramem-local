import { describe, it, expect } from 'vitest';
import { median, computeRobustStats, formatRobustStatsPct, combineRobustStats, printRobustReport, type RobustStats } from './robust-stats.js';
import type { MetricsReport } from './metrics.mts';
import { LOCOMO_CATEGORIES } from '../lib/types.js';

function makeReport(overall: number, categoryAvg: number, perCat: Partial<Record<number, number>> = {}): MetricsReport {
  const per_category = {} as MetricsReport['per_category'];
  for (const c of LOCOMO_CATEGORIES) {
    const acc = perCat[c] ?? overall;
    per_category[c] = { accuracy: acc, n: 10, name: String(c) };
  }
  return { per_category, category_averaged_accuracy: categoryAvg, overall_accuracy: overall, n_total: 50 };
}

describe('median', () => {
  it('returns the middle value for an odd-length array', () => {
    expect(median([0.5, 0.7, 0.6])).toBe(0.6);
  });
  it('averages the two middle values for an even-length array', () => {
    expect(median([0.5, 0.6, 0.7, 0.8])).toBeCloseTo(0.65, 10);
  });
  it('ignores non-finite values', () => {
    expect(median([0.5, NaN, 0.7, Infinity, 0.6])).toBe(0.6);
  });
  it('returns null for an empty/all-non-finite array', () => {
    expect(median([])).toBeNull();
    expect(median([NaN, Infinity])).toBeNull();
  });
  it('single value: median is that value', () => {
    expect(median([0.42])).toBe(0.42);
  });
});

describe('computeRobustStats', () => {
  it('bundles median/min/max/range/n/sorted, dropping non-finite entries', () => {
    const s = computeRobustStats([0.6, NaN, 0.5, 0.7]);
    expect(s.n).toBe(3);
    expect(s.sorted).toEqual([0.5, 0.6, 0.7]);
    expect(s.median).toBe(0.6);
    expect(s.min).toBe(0.5);
    expect(s.max).toBe(0.7);
    expect(s.range).toBeCloseTo(0.2, 10);
  });
  it('single value: median set, range null (nothing to spread over), n=1', () => {
    const s = computeRobustStats([0.42]);
    expect(s.median).toBe(0.42);
    expect(s.min).toBe(0.42);
    expect(s.max).toBe(0.42);
    expect(s.range).toBeNull();
    expect(s.n).toBe(1);
  });
  it('empty array: everything null, n=0', () => {
    const s = computeRobustStats([]);
    expect(s).toEqual({ median: null, min: null, max: null, range: null, n: 0, sorted: [] });
  });
  it('is robust to a single outlier the way a mean is not (the whole point of this module)', () => {
    // Two good-day runs at ~0.58, one bad-day outlier at 0.40 (the LEDGER's
    // proven ±4.3-ish single-extraction swing, exaggerated here for a clean
    // assertion) -- median should sit near the two good runs, not be dragged
    // toward the outlier the way an arithmetic mean would be.
    const s = computeRobustStats([0.58, 0.40, 0.59]);
    expect(s.median).toBe(0.58);
    const mean = (0.58 + 0.40 + 0.59) / 3;
    expect(s.median).toBeGreaterThan(mean);
  });
});

describe('formatRobustStatsPct', () => {
  it('renders median + range as percentages when a range is available', () => {
    const s: RobustStats = { median: 0.57, min: 0.53, max: 0.61, range: 0.08, n: 3, sorted: [0.53, 0.57, 0.61] };
    expect(formatRobustStatsPct(s)).toBe('57.0% (range 53.0%-61.0%, n=3)');
  });
  it('renders a bare percentage + n when range is unavailable (n=1)', () => {
    const s: RobustStats = { median: 0.5, min: 0.5, max: 0.5, range: null, n: 1, sorted: [0.5] };
    expect(formatRobustStatsPct(s)).toBe('50.0% (n=1)');
  });
  it('renders an em-dash for null/undefined/empty stats', () => {
    expect(formatRobustStatsPct(null)).toBe('—');
    expect(formatRobustStatsPct(undefined)).toBe('—');
    expect(formatRobustStatsPct({ median: null, min: null, max: null, range: null, n: 0, sorted: [] })).toBe('—');
  });
});

describe('combineRobustStats', () => {
  it('throws on an empty report array (mirrors combineMetricsReports)', () => {
    expect(() => combineRobustStats([])).toThrow(/at least one run/);
  });

  it('works with a single report -- median equals the one value, range null', () => {
    const report = makeReport(0.6, 0.55);
    const combined = combineRobustStats([report]);
    expect(combined.runs).toBe(1);
    expect(combined.overall_accuracy_robust.median).toBe(0.6);
    expect(combined.overall_accuracy_robust.range).toBeNull();
    expect(combined.category_averaged_accuracy_robust.median).toBe(0.55);
  });

  it('combines N>=2 reports into per-category and overall median/range', () => {
    const reports = [makeReport(0.50, 0.48), makeReport(0.60, 0.58), makeReport(0.55, 0.53)];
    const combined = combineRobustStats(reports);
    expect(combined.runs).toBe(3);
    expect(combined.overall_accuracy_robust.median).toBe(0.55);
    expect(combined.overall_accuracy_robust.min).toBe(0.50);
    expect(combined.overall_accuracy_robust.max).toBe(0.60);
    expect(combined.overall_accuracy_robust.range).toBeCloseTo(0.10, 10);
    expect(combined.category_averaged_accuracy_robust.median).toBe(0.53);
    for (const c of LOCOMO_CATEGORIES) {
      expect(combined.category_robust_stats[c].accuracy.n).toBe(3);
    }
  });

  it('an outlier repeat pulls the mean but not the median (integration of the module-header claim)', () => {
    // Two service-day-consistent repeats + one bad-extraction-day outlier.
    const reports = [makeReport(0.58), makeReport(0.59), makeReport(0.40)];
    const combined = combineRobustStats(reports);
    const mean = (0.58 + 0.59 + 0.40) / 3;
    expect(combined.overall_accuracy_robust.median).toBe(0.58);
    expect(combined.overall_accuracy_robust.median).toBeGreaterThan(mean);
  });

  it('printRobustReport does not throw for a combined report (smoke check)', () => {
    const combined = combineRobustStats([makeReport(0.5, 0.5), makeReport(0.6, 0.6)]);
    expect(() => printRobustReport(combined)).not.toThrow();
  });
});
