import { describe, it, expect, vi } from 'vitest';
import {
  normalizeAnswer, f1Score, multiAnswerF1, isAbstentionPhrase, scoreHypothesis,
  computeMetrics, scoreRun, combineMetricsReports, printMultiRunReport, type ScoredQa, type MetricsReport,
} from './metrics.mts';
import type { LoCoMoSample } from '../lib/types.js';

describe('normalizeAnswer', () => {
  it('lowercases, strips punctuation, and drops standalone articles', () => {
    expect(normalizeAnswer('The Minnesota Wolves')).toBe('minnesota wolves');
  });

  it('strips "and" too (upstream quirk kept for fidelity, see metrics.ts header)', () => {
    expect(normalizeAnswer('pottery and camping')).toBe('pottery camping');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeAnswer('a   b')).toBe('b');
  });
});

describe('f1Score', () => {
  it('is 1 for equivalent strings modulo case/normalization', () => {
    expect(f1Score('new Prius', 'new prius')).toBe(1);
  });

  it('is 0 for completely disjoint strings', () => {
    expect(f1Score('apples', 'oranges')).toBe(0);
  });

  it('is a partial score for a substring match', () => {
    expect(f1Score('no', 'Likely no')).toBeCloseTo(0.6667, 3);
  });

  it('is 0 when either side normalizes to nothing', () => {
    expect(f1Score('', 'something')).toBe(0);
    expect(f1Score('the a an', 'something')).toBe(0);
  });
});

describe('multiAnswerF1', () => {
  it('takes the max predicted-answer F1 per ground-truth part, averaged across parts', () => {
    expect(multiAnswerF1('Psychology, counseling', 'Psychology, counseling certification')).toBeCloseTo(0.8333, 3);
  });

  it('is 1 when every comma-separated part matches exactly', () => {
    expect(multiAnswerF1('beach, mountains, forest', 'beach, mountains, forest')).toBe(1);
  });
});

describe('isAbstentionPhrase', () => {
  it('matches "no information available" case-insensitively', () => {
    expect(isAbstentionPhrase('Sorry, No Information Available.')).toBe(true);
  });

  it('matches "not mentioned"', () => {
    expect(isAbstentionPhrase('That is not mentioned in the notes.')).toBe(true);
  });

  it('does not match an ordinary confident answer', () => {
    expect(isAbstentionPhrase('purple')).toBe(false);
  });
});

describe('scoreHypothesis', () => {
  it('category 1 (multi-hop) uses comma-split multi-answer F1', () => {
    expect(scoreHypothesis(1, 'Psychology, counseling', 'Psychology, counseling certification')).toBeCloseTo(0.8333, 3);
  });

  it('category 2 (temporal) uses plain F1', () => {
    expect(scoreHypothesis(2, '7 May 2023', '7 May 2023')).toBe(1);
  });

  it('category 3 (open-domain) truncates the reference answer at the first semicolon', () => {
    expect(scoreHypothesis(3, 'no', 'Likely no; though she likes reading, she wants to be a counselor')).toBeCloseTo(0.6667, 3);
  });

  it('category 4 (single-hop) coerces a numeric reference answer to a string', () => {
    expect(scoreHypothesis(4, '2022', 2022)).toBe(1);
  });

  it('category 5 (adversarial) scores 1 iff the hypothesis abstains, regardless of `answer`', () => {
    expect(scoreHypothesis(5, 'no information available', undefined)).toBe(1);
    expect(scoreHypothesis(5, 'purple', undefined)).toBe(0);
  });

  it('throws for a non-adversarial category with no reference answer', () => {
    expect(() => scoreHypothesis(4, 'anything', undefined)).toThrow(/missing its reference answer/);
  });
});

describe('computeMetrics', () => {
  it('aggregates per-category and overall accuracy', () => {
    const scored: ScoredQa[] = [
      { qa_id: 'a#0', category: 1, score: 1 },
      { qa_id: 'a#1', category: 1, score: 0 },
      { qa_id: 'a#2', category: 5, score: 1 },
    ];
    const report = computeMetrics(scored);
    expect(report.per_category[1]).toMatchObject({ accuracy: 0.5, n: 2 });
    expect(report.per_category[5]).toMatchObject({ accuracy: 1, n: 1 });
    expect(report.per_category[2].n).toBe(0);
    expect(Number.isNaN(report.per_category[2].accuracy)).toBe(true);
    expect(report.overall_accuracy).toBeCloseTo(2 / 3, 5);
    expect(report.n_total).toBe(3);
  });

  it('category-averaged accuracy weights each present category equally, not each QA', () => {
    // category 1: two QA, both correct (acc=1). category 5: one QA, wrong (acc=0).
    // overall_accuracy (per-QA) = 2/3; category_averaged = mean(1, 0) = 0.5.
    const scored: ScoredQa[] = [
      { qa_id: 'a#0', category: 1, score: 1 },
      { qa_id: 'a#1', category: 1, score: 1 },
      { qa_id: 'a#2', category: 5, score: 0 },
    ];
    const report = computeMetrics(scored);
    expect(report.overall_accuracy).toBeCloseTo(2 / 3, 5);
    expect(report.category_averaged_accuracy).toBe(0.5);
  });
});

describe('scoreRun', () => {
  const references: LoCoMoSample[] = [{
    sample_id: 'conv-a',
    conversation: { speaker_a: 'A', speaker_b: 'B', session_1_date_time: '1:00 pm on 1 January, 2023', session_1: [] },
    qa: [
      { question: 'q0', answer: 'yes', evidence: [], category: 4 },
      { question: 'q1', answer: undefined, adversarial_answer: 'trap', evidence: [], category: 5 },
    ],
  }];

  it('joins hypotheses to references by qa_id and scores each', () => {
    const hyps = [
      { qa_id: 'conv-a#0', sample_id: 'conv-a', category: 4 as const, hypothesis: 'yes' },
      { qa_id: 'conv-a#1', sample_id: 'conv-a', category: 5 as const, hypothesis: 'not mentioned' },
    ];
    const report = scoreRun(hyps, references);
    expect(report.overall_accuracy).toBe(1);
    expect(report.n_total).toBe(2);
  });

  it('excludes distill-timeout skips from scoring rather than counting them wrong', () => {
    const hyps = [
      { qa_id: 'conv-a#0', sample_id: 'conv-a', category: 4 as const, hypothesis: '(skipped: conversation did not finish distilling within timeout)' },
      { qa_id: 'conv-a#1', sample_id: 'conv-a', category: 5 as const, hypothesis: 'not mentioned' },
    ];
    const report = scoreRun(hyps, references);
    expect(report.n_total).toBe(1);
    expect(report.overall_accuracy).toBe(1);
  });

  it('warns and skips a hypothesis whose qa_id is not found in the reference', () => {
    const hyps = [
      { qa_id: 'conv-a#99', sample_id: 'conv-a', category: 4 as const, hypothesis: 'yes' },
    ];
    const report = scoreRun(hyps, references);
    expect(report.n_total).toBe(0);
  });
});

describe('combineMetricsReports — AC-4 multi-run mean±stdev (FEAT-457 slice 1)', () => {
  // run 1: category 4 scores [1, 0] -> accuracy 0.5, n=2; category 5 scores
  // [1] -> accuracy 1, n=1. overall = 2/3, n_total=3, category_averaged=0.75.
  const run1: MetricsReport = computeMetrics([
    { qa_id: 'a#0', category: 4, score: 1 },
    { qa_id: 'a#1', category: 4, score: 0 },
    { qa_id: 'a#2', category: 5, score: 1 },
  ]);
  // run 2: category 4 scores [1, 1] -> accuracy 1, n=2; category 5 scores
  // [0] -> accuracy 0, n=1. overall = 2/3, n_total=3, category_averaged=0.5.
  const run2: MetricsReport = computeMetrics([
    { qa_id: 'a#0', category: 4, score: 1 },
    { qa_id: 'a#1', category: 4, score: 1 },
    { qa_id: 'a#2', category: 5, score: 0 },
  ]);

  it('with exactly one report, returns it completely unchanged (no runs/*_stats keys) — backward compat', () => {
    const combined = combineMetricsReports([run1]);
    expect(combined).toBe(run1); // same object identity, zero transformation
    expect('runs' in combined).toBe(false);
    expect('category_stats' in combined).toBe(false);
  });

  it('throws on an empty report list', () => {
    expect(() => combineMetricsReports([])).toThrow(/at least one run/);
  });

  it('with N>1 reports, computes mean±stdev per category by hand-checked values', () => {
    const combined = combineMetricsReports([run1, run2]);
    expect(combined.runs).toHaveLength(2);

    // category 4: accuracies [0.5, 1] -> mean 0.75, sample stdev sqrt(0.125)
    expect(combined.category_stats![4].accuracy.mean).toBeCloseTo(0.75, 10);
    expect(combined.category_stats![4].accuracy.stdev).toBeCloseTo(Math.sqrt(0.125), 10);
    expect(combined.per_category[4].n).toBe(4); // 2 + 2 pooled QA count
    expect(combined.per_category[4].accuracy).toBeCloseTo(0.75, 10); // mean surfaced as the plain field too

    // category 5: accuracies [1, 0] -> mean 0.5, sample stdev sqrt(0.5)
    expect(combined.category_stats![5].accuracy.mean).toBeCloseTo(0.5, 10);
    expect(combined.category_stats![5].accuracy.stdev).toBeCloseTo(Math.sqrt(0.5), 10);
    expect(combined.per_category[5].n).toBe(2); // 1 + 1

    // categories with zero QA in both runs stay NaN/empty, not a fabricated 0
    expect(combined.per_category[1].n).toBe(0);
    expect(Number.isNaN(combined.per_category[1].accuracy)).toBe(true);
    expect(combined.category_stats![1].accuracy.n).toBe(0);
    expect(combined.category_stats![1].accuracy.mean).toBeNull();

    // category_averaged_accuracy per run: [0.75, 0.5] -> mean 0.625, stdev sqrt(0.03125)
    expect(combined.category_averaged_accuracy).toBeCloseTo(0.625, 10);
    expect(combined.category_averaged_accuracy_stats!.mean).toBeCloseTo(0.625, 10);
    expect(combined.category_averaged_accuracy_stats!.stdev).toBeCloseTo(Math.sqrt(0.03125), 10);

    // overall_accuracy is 2/3 in both runs -> mean 2/3, stdev 0 (identical runs)
    expect(combined.overall_accuracy).toBeCloseTo(2 / 3, 10);
    expect(combined.overall_accuracy_stats!.mean).toBeCloseTo(2 / 3, 10);
    expect(combined.overall_accuracy_stats!.stdev).toBe(0);

    // n_total pools across runs (3 + 3), not averaged
    expect(combined.n_total).toBe(6);
  });
});

describe('printMultiRunReport — runs-contributing annotation (review fix, low-severity observability nit)', () => {
  function captureLogs(fn: () => void): string[] {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
    try {
      fn();
    } finally {
      spy.mockRestore();
    }
    return logs;
  }

  it('appends "x/y runs" when a category is present in fewer runs than the total (e.g. emptied by a distill timeout)', () => {
    // run A: only category 4 has QA. run B: only category 5 has QA -- so
    // each category is contributed by exactly 1 of the 2 runs.
    const runA = computeMetrics([{ qa_id: 'a#0', category: 4, score: 1 }]);
    const runB = computeMetrics([{ qa_id: 'b#0', category: 5, score: 1 }]);
    const combined = combineMetricsReports([runA, runB]);

    const logs = captureLogs(() => printMultiRunReport(combined));
    const cat4Line = logs.find(l => l.includes('(single-hop)'));
    const cat5Line = logs.find(l => l.includes('(adversarial)'));
    expect(cat4Line).toContain('1/2 runs');
    expect(cat5Line).toContain('1/2 runs');
  });

  it('omits the runs-contributing note when every run contributed to a category', () => {
    const runA = computeMetrics([{ qa_id: 'a#0', category: 4, score: 1 }, { qa_id: 'a#1', category: 4, score: 0 }]);
    const runB = computeMetrics([{ qa_id: 'b#0', category: 4, score: 1 }]);
    const combined = combineMetricsReports([runA, runB]);

    const logs = captureLogs(() => printMultiRunReport(combined));
    const cat4Line = logs.find(l => l.includes('(single-hop)'));
    expect(cat4Line).not.toContain('runs)');
    expect(cat4Line).toContain('n=3'); // pooled QA count (2 + 1), still shown
  });

  it('delegates a single-report (no runs/category_stats) straight to the single-run print path unchanged', () => {
    const single = computeMetrics([{ qa_id: 'a#0', category: 4, score: 1 }]);
    const logs = captureLogs(() => printMultiRunReport(single));
    expect(logs.some(l => l.includes('mean ± stdev'))).toBe(false);
    expect(logs.some(l => l.includes('runs)'))).toBe(false);
  });
});
