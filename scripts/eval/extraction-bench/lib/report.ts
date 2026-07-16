/**
 * Report types + aggregation/rendering (FEAT-450).
 *
 * Split out of run-bench.mts so the pure math (aggregation, multi-run
 * combination, markdown rendering, significance labeling) is importable and
 * unit-testable without spinning up a daemon or an Azure client — see
 * lib/report.test.ts.
 *
 * AC-5 (regression-free): `combineRuns([oneRun])` returns that run's report
 * object completely unchanged — same fields, same shape as the pre-FEAT-450
 * single-run report. The `runs`/`stats` fields only appear when more than
 * one run was collected.
 */
import { mean, computeStats, compareMeans, formatStatsPct, type Stats } from '../../shared/stats.js';
import type { FixtureScore, JudgeAtomIn, JudgeAgreementReport } from './judge.js';

export interface FixtureReportRow {
  fixtureId: string;
  difficulty: string;
  status: string;
  wallMs: number;
  poisonJobs: number;
  atoms: JudgeAtomIn[];
  score: FixtureScore | null;
  /** FEAT-534: pre-merge per-pass atom counts for a mixed-pass
   *  (`+passB=`) run — `atoms` above is always the final MERGED/deduped
   *  set. `undefined` on every single-pass fixture (the default), same
   *  optional-when-not-applicable shape `DirectRunResult` itself uses
   *  (scripts/eval/extraction-bench/lib/pipeline-direct.ts). Review finding
   *  (PR #376): these previously reached only console.log, never the
   *  archived results.json/report.md — AC-4's "measurement gate for
   *  adopting hybrid as default" needs them persisted, not just printed. */
  passAAtomCount?: number;
  passBAtomCount?: number;
}

export interface RunAggregate {
  avgRecall: number | null;
  avgPrecision: number | null;
  f1: number | null;
  avgJunkRate: number | null;
  avgTypeAccuracy: number | null;
  overExtractionOnNothingFixture: number | null;
  failedFixtures: number;
  avgWallMsPerSession: number;
  totalWallMs: number;
  azureUsd: number;
  /** FEAT-534: mean pre-merge per-pass atom count across this run's
   *  fixtures, for a mixed-pass (`+passB=`) run — `null` when no fixture in
   *  the run carried a pass split (single-pass, the overwhelming majority
   *  of runs). See FixtureReportRow.passAAtomCount/passBAtomCount. */
  avgPassAAtomCount: number | null;
  avgPassBAtomCount: number | null;
}

/** One model, one run — the pre-FEAT-450 report shape. */
export interface SingleRunReport {
  model: string;
  daemonBootMs: number | null;
  fixtures: FixtureReportRow[];
  aggregate: RunAggregate;
}

export interface MultiRunStats {
  recall: Stats;
  precision: Stats;
  f1: Stats;
  typeAccuracy: Stats;
}

/**
 * One model's report. When only one run was collected this is exactly a
 * SingleRunReport (no `runs`/`stats` fields at all — not even `undefined`
 * keys, since combineRuns short-circuits and returns the run object as-is).
 * When N>1 runs were collected, `aggregate` becomes the mean-of-per-run
 * aggregate (still plain numbers, so old code reading `.aggregate.f1`
 * keeps working), `runs` retains every per-run raw aggregate, and `stats`
 * carries mean+stdev for the four AC-1 metrics.
 */
export interface ModelReport extends SingleRunReport {
  runs?: RunAggregate[];
  stats?: MultiRunStats;
}

/** Aggregate one run's per-fixture scores into a RunAggregate. */
export function aggregateFixtureScores(fixtureReports: FixtureReportRow[], azureUsd: number): RunAggregate {
  const scored = fixtureReports.filter(f => f.score !== null).map(f => f.score as FixtureScore);
  const recalls = scored.map(s => s.recall).filter((r): r is number => r !== null);
  const precisions = scored.map(s => s.precision).filter((p): p is number => p !== null);
  const junkRates = scored.map(s => s.junkRate).filter((j): j is number => j !== null);
  const typeAccs = scored.map(s => s.typeAccuracy).filter((t): t is number => t !== null);
  const avgRecall = mean(recalls);
  const avgPrecision = mean(precisions);
  const f1 = avgRecall !== null && avgPrecision !== null && (avgRecall + avgPrecision) > 0
    ? (2 * avgRecall * avgPrecision) / (avgRecall + avgPrecision)
    : null;
  const nothingFixtureScore = scored.find(s => s.fixtureId === 'fx09-nothing-worth-remembering');

  const wallTimes = fixtureReports.filter(f => f.status !== 'error').map(f => f.wallMs);
  const failedFixtures = fixtureReports.filter(f => f.status === 'error' || f.status === 'timeout' || f.status === 'partial').length;

  // FEAT-534: per-pass atom counts, present only on fixtures a mixed-pass
  // (`+passB=`) run actually ran dual-pass on — filtered like junkRates/
  // typeAccs above, not read off `score` (these come from the extraction
  // result itself, independent of judging).
  const passAAtomCounts = fixtureReports.map(f => f.passAAtomCount).filter((n): n is number => n !== undefined);
  const passBAtomCounts = fixtureReports.map(f => f.passBAtomCount).filter((n): n is number => n !== undefined);

  return {
    avgRecall,
    avgPrecision,
    f1,
    avgJunkRate: mean(junkRates),
    avgTypeAccuracy: mean(typeAccs),
    overExtractionOnNothingFixture: nothingFixtureScore?.overExtractionCount ?? null,
    failedFixtures,
    avgWallMsPerSession: mean(wallTimes) ?? 0,
    totalWallMs: wallTimes.reduce((a, b) => a + b, 0),
    azureUsd,
    avgPassAAtomCount: mean(passAAtomCounts),
    avgPassBAtomCount: mean(passBAtomCounts),
  };
}

/**
 * Combine N per-run reports for the same model into one ModelReport.
 * AC-1: retains every raw per-run aggregate (`runs`) and computes mean+stdev
 * (`stats`) for recall/precision/F1/type-accuracy across the runs.
 * AC-5: with exactly one run, returns it unchanged (no shape drift).
 */
export function combineRuns(runs: SingleRunReport[]): ModelReport {
  if (runs.length === 0) throw new Error('combineRuns requires at least one run');
  if (runs.length === 1) return runs[0] as ModelReport;

  const last = runs[runs.length - 1] as SingleRunReport;
  const aggregates = runs.map(r => r.aggregate);
  const stats: MultiRunStats = {
    recall: computeStats(aggregates.map(a => a.avgRecall ?? NaN)),
    precision: computeStats(aggregates.map(a => a.avgPrecision ?? NaN)),
    f1: computeStats(aggregates.map(a => a.f1 ?? NaN)),
    typeAccuracy: computeStats(aggregates.map(a => a.avgTypeAccuracy ?? NaN)),
  };

  const centralAggregate: RunAggregate = {
    avgRecall: stats.recall.mean,
    avgPrecision: stats.precision.mean,
    f1: stats.f1.mean,
    avgJunkRate: mean(aggregates.map(a => a.avgJunkRate ?? NaN)),
    avgTypeAccuracy: stats.typeAccuracy.mean,
    overExtractionOnNothingFixture: mean(aggregates.map(a => a.overExtractionOnNothingFixture ?? NaN)),
    failedFixtures: Math.round(mean(aggregates.map(a => a.failedFixtures)) ?? 0),
    avgWallMsPerSession: mean(aggregates.map(a => a.avgWallMsPerSession)) ?? 0,
    totalWallMs: aggregates.reduce((s, a) => s + a.totalWallMs, 0),
    azureUsd: aggregates.reduce((s, a) => s + a.azureUsd, 0),
    // FEAT-534: same mean-of-per-run-means pattern overExtractionOnNothingFixture
    // uses just above — null-safe via mean()'s NaN filtering when a run had no
    // pass split at all.
    avgPassAAtomCount: mean(aggregates.map(a => a.avgPassAAtomCount ?? NaN)),
    avgPassBAtomCount: mean(aggregates.map(a => a.avgPassBAtomCount ?? NaN)),
  };

  return {
    model: last.model,
    daemonBootMs: last.daemonBootMs,
    fixtures: last.fixtures,
    aggregate: centralAggregate,
    runs: aggregates,
    stats,
  };
}

export interface RenderOptions {
  judgeReasoningEffort?: string;
  agreement?: JudgeAgreementReport[];
}

export function renderMarkdown(reports: ModelReport[], judgeUsd: number, opts: RenderOptions = {}): string {
  const lines: string[] = [];
  lines.push('# Extraction-bench results', '');
  // FEAT-534 (review finding, PR #376): Pass A/Pass B atom columns — the
  // model column already identifies the pass split (the raw `+passB=` spec
  // string flows through as `r.model` unchanged), but the per-pass atom
  // COUNTS previously reached only console.log, never this archived table.
  // "—" for every single-pass row (avgPassAAtomCount/avgPassBAtomCount both
  // null) keeps the table's shape unchanged for the overwhelming majority
  // of runs that never use `+passB=`.
  lines.push('| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  const fmtPct = (n: number | null) => (n === null ? '—' : `${(n * 100).toFixed(0)}%`);
  const fmtCount = (n: number | null) => (n === null ? '—' : n.toFixed(1));
  for (const r of reports) {
    const a = r.aggregate;
    const recallCell = r.stats ? formatStatsPct(r.stats.recall) : fmtPct(a.avgRecall);
    const precisionCell = r.stats ? formatStatsPct(r.stats.precision) : fmtPct(a.avgPrecision);
    const f1Cell = r.stats ? formatStatsPct(r.stats.f1) : fmtPct(a.f1);
    const typeAccCell = r.stats ? formatStatsPct(r.stats.typeAccuracy) : fmtPct(a.avgTypeAccuracy);
    const modelCell = r.runs ? `${r.model} (n=${r.runs.length})` : r.model;
    lines.push(
      `| ${modelCell} | ${recallCell} | ${precisionCell} | ${f1Cell} | ${fmtPct(a.avgJunkRate)} | ${typeAccCell} | ${a.overExtractionOnNothingFixture ?? '—'} | ${(a.avgWallMsPerSession / 1000).toFixed(1)}s | ${a.failedFixtures} | $${a.azureUsd.toFixed(4)} | ${fmtCount(a.avgPassAAtomCount)} | ${fmtCount(a.avgPassBAtomCount)} |`,
    );
  }
  lines.push('', `_Judge: Azure gpt-5-mini (reasoning_effort=${opts.judgeReasoningEffort ?? 'minimal'}). Estimated judge spend this run: ~$${judgeUsd.toFixed(3)}._`);

  // AC-2: pairwise significance gate — only meaningful once at least two
  // models both have a multi-run stdev to compare (a single run has no
  // noise estimate; compareMeans reports "insufficient data" in that case,
  // so this section is skipped entirely when nothing has `stats`).
  const withStats = reports.filter((r): r is ModelReport & { stats: MultiRunStats } => r.stats !== undefined);
  if (withStats.length >= 2) {
    lines.push('', '## Significance (F1, pairwise)', '');
    lines.push(
      "_Noise floor = 2 × standard-error-of-the-difference, derived from each config's observed per-run F1 stdev. " +
      'A delta at or below the floor is indistinguishable from run-to-run noise and is NOT ranked._',
      '',
    );
    lines.push('| A | B | ΔF1 (A−B) | Noise floor | Verdict |');
    lines.push('|---|---|---|---|---|');
    for (let i = 0; i < withStats.length; i++) {
      for (let j = i + 1; j < withStats.length; j++) {
        const A = withStats[i] as ModelReport & { stats: MultiRunStats };
        const B = withStats[j] as ModelReport & { stats: MultiRunStats };
        const cmp = compareMeans(A.stats.f1, B.stats.f1);
        const deltaStr = Number.isNaN(cmp.noiseFloor) ? '—' : `${(cmp.delta * 100).toFixed(1)}pp`;
        const floorStr = Number.isNaN(cmp.noiseFloor) ? '—' : `${(cmp.noiseFloor * 100).toFixed(1)}pp`;
        lines.push(`| ${A.model} | ${B.model} | ${deltaStr} | ${floorStr} | ${cmp.label} |`);
      }
    }
  }

  // AC-4: judge self-agreement — same atom set re-judged multiple times,
  // isolating judge noise from model/extraction noise.
  if (opts.agreement && opts.agreement.length > 0) {
    lines.push('', '## Judge self-agreement', '');
    lines.push('_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._', '');
    lines.push('| Fixture | Repeats | Recall | Precision | F1 |');
    lines.push('|---|---|---|---|---|');
    for (const a of opts.agreement) {
      lines.push(`| ${a.fixtureId} | ${a.repeats} | ${formatStatsPct(a.recall)} | ${formatStatsPct(a.precision)} | ${formatStatsPct(a.f1)} |`);
    }
  }

  return lines.join('\n');
}
