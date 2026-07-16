import { describe, it, expect } from 'vitest';
import { aggregateFixtureScores, combineRuns, renderMarkdown, type FixtureReportRow, type SingleRunReport } from './report.js';
import type { FixtureScore, JudgeAgreementReport } from './judge.js';

function score(overrides: Partial<FixtureScore> & { fixtureId: string }): FixtureScore {
  return {
    goldCount: 1,
    extractedCount: 1,
    recall: 1,
    precision: 1,
    junkRate: 0,
    typeAccuracy: 1,
    overExtractionCount: null,
    judge: { extracted_verdicts: [], unmatched_gold_indices: [] },
    ...overrides,
  };
}

function fixtureRow(fixtureId: string, s: FixtureScore | null, extra: Partial<FixtureReportRow> = {}): FixtureReportRow {
  return {
    fixtureId,
    difficulty: 'clean',
    status: 'ready',
    wallMs: 1000,
    poisonJobs: 0,
    atoms: [{ type: 'fact', text: 'x' }],
    score: s,
    ...extra,
  };
}

describe('aggregateFixtureScores', () => {
  it('computes recall/precision/F1 as means-of-per-fixture-scores, harmonic F1 from the means', () => {
    const rows = [
      fixtureRow('fx01', score({ fixtureId: 'fx01', recall: 1, precision: 1 })),
      fixtureRow('fx02', score({ fixtureId: 'fx02', recall: 0.5, precision: 0.5 })),
    ];
    const agg = aggregateFixtureScores(rows, 0.01);
    expect(agg.avgRecall).toBeCloseTo(0.75, 10);
    expect(agg.avgPrecision).toBeCloseTo(0.75, 10);
    expect(agg.f1).toBeCloseTo(0.75, 10); // recall === precision -> F1 === both
    expect(agg.azureUsd).toBe(0.01);
  });

  it('counts error/timeout/partial statuses as failed fixtures; only "error" is excluded from wall-time (preserved pre-existing behavior)', () => {
    const rows = [
      fixtureRow('fx01', score({ fixtureId: 'fx01' }), { status: 'ready', wallMs: 1000 }),
      fixtureRow('fx02', null, { status: 'error', wallMs: 999999 }),
      fixtureRow('fx03', null, { status: 'timeout', wallMs: 2000 }),
    ];
    const agg = aggregateFixtureScores(rows, 0);
    expect(agg.failedFixtures).toBe(2);
    expect(agg.avgWallMsPerSession).toBe(1500); // only the 'error' row is excluded; 'timeout' still counts
  });

  it('surfaces the nothing-fixture overExtractionCount unchanged', () => {
    const rows = [fixtureRow('fx09-nothing-worth-remembering', score({ fixtureId: 'fx09-nothing-worth-remembering', overExtractionCount: 3, recall: null, precision: null }))];
    const agg = aggregateFixtureScores(rows, 0);
    expect(agg.overExtractionOnNothingFixture).toBe(3);
  });

  // FEAT-534 (review finding, PR #376): per-pass atom counts must reach the
  // archived aggregate, not just console.log.
  it('averages passAAtomCount/passBAtomCount across fixtures that carry a pass split', () => {
    const rows = [
      fixtureRow('fx01', score({ fixtureId: 'fx01' }), { passAAtomCount: 3, passBAtomCount: 2 }),
      fixtureRow('fx02', score({ fixtureId: 'fx02' }), { passAAtomCount: 5, passBAtomCount: 4 }),
    ];
    const agg = aggregateFixtureScores(rows, 0);
    expect(agg.avgPassAAtomCount).toBe(4);
    expect(agg.avgPassBAtomCount).toBe(3);
  });

  it('is null (not 0, not NaN) when no fixture in the run carried a pass split — the single-pass default', () => {
    const rows = [fixtureRow('fx01', score({ fixtureId: 'fx01' }))];
    const agg = aggregateFixtureScores(rows, 0);
    expect(agg.avgPassAAtomCount).toBeNull();
    expect(agg.avgPassBAtomCount).toBeNull();
  });
});

describe('combineRuns — AC-5 regression-free + AC-1 multi-run', () => {
  function makeSingleRun(model: string, f1: number): SingleRunReport {
    const rows = [fixtureRow('fx01', score({ fixtureId: 'fx01', recall: f1, precision: f1, typeAccuracy: f1 }))];
    return { model, daemonBootMs: 500, fixtures: rows, aggregate: aggregateFixtureScores(rows, 0) };
  }

  it('AC-5: with exactly one run, returns the run object completely unchanged (no runs/stats fields at all)', () => {
    const single = makeSingleRun('qwen2.5-coder:7b', 0.6);
    const combined = combineRuns([single]);
    expect(combined).toBe(single); // same object identity — zero transformation
    expect('runs' in combined).toBe(false);
    expect('stats' in combined).toBe(false);
  });

  it('AC-1: with N>1 runs, reports mean±stdev for recall/precision/F1/type-accuracy and retains raw per-run aggregates', () => {
    const runs = [makeSingleRun('m', 0.50), makeSingleRun('m', 0.60), makeSingleRun('m', 0.70)];
    const combined = combineRuns(runs);
    expect(combined.runs).toHaveLength(3);
    expect(combined.stats).toBeDefined();
    expect(combined.stats!.f1.mean).toBeCloseTo(0.6, 10);
    expect(combined.stats!.f1.stdev).not.toBeNull();
    expect(combined.stats!.f1.n).toBe(3);
    // central aggregate stays a plain number, matching the old shape's contract
    expect(combined.aggregate.f1).toBeCloseTo(0.6, 10);
    expect(typeof combined.aggregate.f1).toBe('number');
  });

  it('throws on zero runs (programmer error, not a valid bench state)', () => {
    expect(() => combineRuns([])).toThrow();
  });
});

describe('renderMarkdown', () => {
  it('single-run report: renders bare percentages, no significance/agreement sections (AC-5 shape)', () => {
    const rows = [fixtureRow('fx01', score({ fixtureId: 'fx01', recall: 0.6, precision: 0.8, typeAccuracy: 0.5 }))];
    const report = { model: 'qwen2.5-coder:7b', daemonBootMs: 500, fixtures: rows, aggregate: aggregateFixtureScores(rows, 0) };
    const md = renderMarkdown([report], 0.01);
    expect(md).toContain('# Extraction-bench results');
    expect(md).toContain('60%'); // recall
    expect(md).not.toContain('±');
    expect(md).not.toContain('## Significance');
    expect(md).not.toContain('## Judge self-agreement');
  });

  it('multi-run report: renders mean ± stdev cells and a significance section for >=2 models', () => {
    function multiRunReport(model: string, f1s: number[]) {
      const singleRuns: SingleRunReport[] = f1s.map(f1 => {
        const rows = [fixtureRow('fx01', score({ fixtureId: 'fx01', recall: f1, precision: f1, typeAccuracy: f1 }))];
        return { model, daemonBootMs: 500, fixtures: rows, aggregate: aggregateFixtureScores(rows, 0) };
      });
      return combineRuns(singleRuns);
    }
    const modelA = multiRunReport('big-model', [0.80, 0.82, 0.81]); // tight, high
    const modelB = multiRunReport('small-model', [0.50, 0.60, 0.55]); // noisy, low — clearly separated from A
    const md = renderMarkdown([modelA, modelB], 0.02);
    expect(md).toContain('±');
    expect(md).toContain('## Significance (F1, pairwise)');
    expect(md).toContain('big-model');
    expect(md).toContain('small-model');
    // Clearly separated means -> should NOT be labeled "within noise"
    expect(md).toContain('significant');
  });

  it('renders "within noise / not significant" when configs overlap heavily', () => {
    function multiRunReport(model: string, f1s: number[]) {
      const singleRuns: SingleRunReport[] = f1s.map(f1 => {
        const rows = [fixtureRow('fx01', score({ fixtureId: 'fx01', recall: f1, precision: f1, typeAccuracy: f1 }))];
        return { model, daemonBootMs: 500, fixtures: rows, aggregate: aggregateFixtureScores(rows, 0) };
      });
      return combineRuns(singleRuns);
    }
    // Mirrors the FEAT-450 evidence: near-identical configs with overlapping noise bands.
    const promptV1 = multiRunReport('prompt-v1', [0.50, 0.58, 0.61, 0.67]);
    const promptV2 = multiRunReport('prompt-v2', [0.53, 0.59, 0.61, 0.72]);
    const md = renderMarkdown([promptV1, promptV2], 0);
    expect(md).toContain('within noise / not significant');
  });

  // FEAT-534 (review finding, PR #376): the model column already identifies
  // the pass split via the raw `+passB=` spec string (model name itself),
  // but the archived table previously carried no per-pass atom COUNTS at
  // all — this pins that AC-4's "measurement gate" data actually lands in
  // the rendered report.md, not just a console line that's gone once the
  // process exits.
  it('renders Pass A/Pass B atom columns — populated for a mixed-pass model, "—" for a single-pass one', () => {
    const mixedRows = [
      fixtureRow('fx01', score({ fixtureId: 'fx01' }), { passAAtomCount: 3, passBAtomCount: 2 }),
    ];
    const mixedReport = {
      model: 'codex:gpt-5.4-mini+passB=ollama:qwen3:8b',
      daemonBootMs: 500,
      fixtures: mixedRows,
      aggregate: aggregateFixtureScores(mixedRows, 0),
    };
    const singlePassRows = [fixtureRow('fx01', score({ fixtureId: 'fx01' }))];
    const singlePassReport = {
      model: 'codex:gpt-5.4-mini',
      daemonBootMs: 500,
      fixtures: singlePassRows,
      aggregate: aggregateFixtureScores(singlePassRows, 0),
    };
    const md = renderMarkdown([mixedReport, singlePassReport], 0);
    expect(md).toContain('Pass A atoms');
    expect(md).toContain('Pass B atoms');
    const lines = md.split('\n');
    const mixedLine = lines.find(l => l.startsWith('| codex:gpt-5.4-mini+passB=ollama:qwen3:8b '));
    const singlePassLine = lines.find(l => l.startsWith('| codex:gpt-5.4-mini '));
    // Mixed row: mean atom counts (single fixture here, so exactly 3 / 2).
    expect(mixedLine).toBeDefined();
    expect(mixedLine!.trim().endsWith('| 3.0 | 2.0 |')).toBe(true);
    // Single-pass row: no split at all — both columns render "—".
    expect(singlePassLine).toBeDefined();
    expect(singlePassLine!.trim().endsWith('| — | — |')).toBe(true);
  });

  it('renders a judge self-agreement section when provided', () => {
    const rows = [fixtureRow('fx01', score({ fixtureId: 'fx01' }))];
    const report = { model: 'qwen2.5-coder:7b', daemonBootMs: 500, fixtures: rows, aggregate: aggregateFixtureScores(rows, 0) };
    const agreement: JudgeAgreementReport[] = [{
      fixtureId: 'fx01',
      repeats: 3,
      recall: { mean: 0.9, stdev: 0.05, n: 3, raw: [0.85, 0.9, 0.95] },
      precision: { mean: 0.9, stdev: 0.05, n: 3, raw: [0.85, 0.9, 0.95] },
      f1: { mean: 0.9, stdev: 0.05, n: 3, raw: [0.85, 0.9, 0.95] },
      typeAccuracy: { mean: 1, stdev: 0, n: 3, raw: [1, 1, 1] },
      raw: [],
    }];
    const md = renderMarkdown([report], 0, { agreement });
    expect(md).toContain('## Judge self-agreement');
    expect(md).toContain('fx01');
    expect(md).toContain('90% ± 5%');
  });
});
