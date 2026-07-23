/**
 * Median + spread aggregation, additive alongside ./metrics.mts's
 * combineMetricsReports (mean±stdev). Built for the noise-sampling wrapper
 * (`../repeat-run.mts`, 2026-07-23 measurement-overhaul directive): the
 * README's own LEDGER history shows a proven ±4.3-point single-extraction
 * swing on a small n (n=199 conv-1) sample -- with only 3-5 repeats, a mean
 * is exactly the statistic a single outlier run distorts most, and stdev on
 * n<5 is a rough estimate at best. Median is robust to one bad-day outlier;
 * range/IQR communicate the spread directly in the metric's own units
 * (accuracy points) rather than a stdev an operator has to mentally double.
 *
 * This does NOT replace mean±stdev (`../judge/metrics.mts`'s
 * combineMetricsReports) -- both are computed and printed side by side by
 * `../repeat-run.mts`. A mean/median that agree closely is itself a useful
 * signal (no skew); a mean pulled well away from the median is the tell that
 * one repeat was an outlier day, exactly the day-variance class the LEDGER
 * has repeatedly measured (codex ±6/day).
 *
 * No I/O, no Azure/Ollama dependency -- pure functions over number arrays,
 * same shape as ../../shared/stats.ts (deliberately not extended -- that
 * file is shared with extraction-bench and ../../longmemeval, out of this
 * change's file scope; this is a LoCoMo-local sibling).
 */
import { LOCOMO_CATEGORIES, CATEGORY_NAMES, type LoCoMoCategory } from '../lib/types.js';
import type { MetricsReport } from './metrics.mts';

export interface RobustStats {
  median: number | null;
  min: number | null;
  max: number | null;
  /** max - min. Null when fewer than 2 finite values (nothing to spread over). */
  range: number | null;
  /** Count of finite values that went into the stats. */
  n: number;
  /** The finite values themselves, sorted ascending -- retained for inspection. */
  sorted: number[];
}

/** Median of the finite values in `nums` (average of the two middle values on
 *  an even count -- the standard definition). Null if there are none. */
export function median(nums: number[]): number | null {
  const finite = nums.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (finite.length === 0) return null;
  const mid = Math.floor(finite.length / 2);
  return finite.length % 2 === 1 ? finite[mid]! : (finite[mid - 1]! + finite[mid]!) / 2;
}

/** Compute {median, min, max, range, n, sorted} from a list of per-run values
 *  in one call -- the RobustStats analogue of ../../shared/stats.ts's computeStats. */
export function computeRobustStats(nums: number[]): RobustStats {
  const sorted = nums.filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  if (sorted.length === 0) return { median: null, min: null, max: null, range: null, n: 0, sorted: [] };
  const min = sorted[0]!;
  const max = sorted[sorted.length - 1]!;
  return {
    median: median(sorted),
    min,
    max,
    range: sorted.length >= 2 ? max - min : null,
    n: sorted.length,
    sorted,
  };
}

/** Format a RobustStats as "57% (range 53-61%, n=3)" (or a bare "57% (n=1)"
 *  when there's nothing to spread over). */
export function formatRobustStatsPct(s: RobustStats | null | undefined): string {
  if (!s || s.median === null) return '—';
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  if (s.range === null) return `${pct(s.median)} (n=${s.n})`;
  return `${pct(s.median)} (range ${pct(s.min!)}-${pct(s.max!)}, n=${s.n})`;
}

export interface CategoryRobustStats {
  name: string;
  accuracy: RobustStats;
}

/** RobustStats analogue of ./metrics.mts's MultiRunMetricsReport -- carries
 *  per-category and overall median/spread across N>=1 repeated runs. Always
 *  additive: computed alongside (never in place of) combineMetricsReports's
 *  mean±stdev by ../repeat-run.mts. */
export interface MultiRunRobustReport {
  runs: number;
  category_robust_stats: Record<LoCoMoCategory, CategoryRobustStats>;
  category_averaged_accuracy_robust: RobustStats;
  overall_accuracy_robust: RobustStats;
}

/** Combine N per-run MetricsReports into median/range per category and
 *  overall. Mirrors combineMetricsReports's shape (same per-category
 *  iteration, same category_averaged_accuracy/overall_accuracy source
 *  fields) but reports RobustStats instead of Stats. Works with N=1 (single
 *  run: median === the one value, range === null) so callers never need a
 *  length check before calling it. */
export function combineRobustStats(reports: MetricsReport[]): MultiRunRobustReport {
  if (reports.length === 0) throw new Error('combineRobustStats requires at least one run');

  const categoryRobustStats = {} as Record<LoCoMoCategory, CategoryRobustStats>;
  for (const c of LOCOMO_CATEGORIES) {
    categoryRobustStats[c] = {
      name: CATEGORY_NAMES[c],
      accuracy: computeRobustStats(reports.map(r => r.per_category[c].accuracy)),
    };
  }

  return {
    runs: reports.length,
    category_robust_stats: categoryRobustStats,
    category_averaged_accuracy_robust: computeRobustStats(reports.map(r => r.category_averaged_accuracy)),
    overall_accuracy_robust: computeRobustStats(reports.map(r => r.overall_accuracy)),
  };
}

/** Prints a MultiRunRobustReport alongside (not instead of) printMultiRunReport's
 *  mean±stdev output -- see ../repeat-run.mts for the combined console report. */
export function printRobustReport(report: MultiRunRobustReport): void {
  console.log(`\nLoCoMo results by category (n=${report.runs} runs, median [range]):`);
  for (const c of LOCOMO_CATEGORIES) {
    const { name, accuracy } = report.category_robust_stats[c];
    console.log(`\t${c} (${name}): ${formatRobustStatsPct(accuracy)}`);
  }
  console.log(`\nCategory-averaged accuracy: ${formatRobustStatsPct(report.category_averaged_accuracy_robust)}`);
  console.log(`Overall accuracy: ${formatRobustStatsPct(report.overall_accuracy_robust)}`);
}
