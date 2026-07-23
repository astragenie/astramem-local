import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scorePerQuestionAcrossRuns, pairDeltas, bootstrapMeanCI, decidePairedSignificance,
  decidePairedSignificanceByCategory, formatVerdict, type PairedDelta, type PerQuestionScore,
} from './paired-significance.js';

describe('scorePerQuestionAcrossRuns', () => {
  let dirs: string[];

  beforeEach(() => { dirs = []; });
  afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

  function makeRunDir(hyp: string, answer: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'paired-sig-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'hypotheses.jsonl'), JSON.stringify({ qa_id: 's1#0', sample_id: 's1', category: 4, hypothesis: hyp }) + '\n', 'utf8');
    writeFileSync(join(dir, 'sample.json'), JSON.stringify([
      { sample_id: 's1', conversation: { speaker_a: 'A', speaker_b: 'B' }, qa: [{ question: 'q', answer, evidence: [], category: 4 }] },
    ]), 'utf8');
    return dir;
  }

  it('collects one score per run dir under the same qa_id', () => {
    const a = makeRunDir('paris', 'paris');
    const b = makeRunDir('not paris at all', 'paris');
    const scores = scorePerQuestionAcrossRuns([a, b]);
    expect(scores.size).toBe(1);
    const entry = scores.get('s1#0')!;
    expect(entry.scores).toHaveLength(2);
    expect(entry.scores[0]).toBeCloseTo(1, 5); // exact match
    expect(entry.scores[1]).toBeLessThan(1); // partial/no overlap
  });

  it('skips "(skipped...)" placeholder hypotheses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'paired-sig-'));
    dirs.push(dir);
    writeFileSync(join(dir, 'hypotheses.jsonl'), JSON.stringify({ qa_id: 's1#0', sample_id: 's1', category: 4, hypothesis: '(skipped: shard failed)' }) + '\n', 'utf8');
    writeFileSync(join(dir, 'sample.json'), JSON.stringify([
      { sample_id: 's1', conversation: { speaker_a: 'A', speaker_b: 'B' }, qa: [{ question: 'q', answer: 'paris', evidence: [], category: 4 }] },
    ]), 'utf8');
    expect(scorePerQuestionAcrossRuns([dir]).size).toBe(0);
  });
});

describe('pairDeltas', () => {
  function score(qaId: string, category: 1 | 2 | 3 | 4 | 5, scores: number[]): PerQuestionScore {
    return { qaId, category, scores };
  }

  it('pairs shared qa_ids and computes signed mean deltas (A - B)', () => {
    const a = new Map([
      ['s1#0', score('s1#0', 4, [1, 1])],
      ['s1#1', score('s1#1', 4, [0.5, 0.5])],
    ]);
    const b = new Map([
      ['s1#0', score('s1#0', 4, [0.5, 0.5])],
      ['s1#1', score('s1#1', 4, [0.5, 0.5])],
    ]);
    const { paired, onlyInA, onlyInB } = pairDeltas(a, b);
    expect(paired).toHaveLength(2);
    expect(onlyInA).toBe(0);
    expect(onlyInB).toBe(0);
    const q0 = paired.find(p => p.qaId === 's1#0')!;
    expect(q0.meanA).toBeCloseTo(1, 10);
    expect(q0.meanB).toBeCloseTo(0.5, 10);
    expect(q0.delta).toBeCloseTo(0.5, 10);
    const q1 = paired.find(p => p.qaId === 's1#1')!;
    expect(q1.delta).toBeCloseTo(0, 10);
  });

  it('counts and excludes qa_ids present on only one side', () => {
    const a = new Map([['s1#0', score('s1#0', 4, [1])], ['s1#1', score('s1#1', 4, [1])]]);
    const b = new Map([['s1#0', score('s1#0', 4, [1])], ['s2#0', score('s2#0', 4, [1])]]);
    const { paired, onlyInA, onlyInB } = pairDeltas(a, b);
    expect(paired).toHaveLength(1);
    expect(onlyInA).toBe(1); // s1#1
    expect(onlyInB).toBe(1); // s2#0
  });

  it('empty maps on either side pair to nothing', () => {
    expect(pairDeltas(new Map(), new Map())).toEqual({ paired: [], onlyInA: 0, onlyInB: 0 });
  });
});

describe('bootstrapMeanCI', () => {
  it('returns null for an empty array', () => {
    expect(bootstrapMeanCI([])).toBeNull();
  });

  it('is deterministic given the same seed', () => {
    const values = [0.1, 0.2, -0.05, 0.15, 0.0, 0.12, 0.08];
    const a = bootstrapMeanCI(values, { seed: 7, iterations: 500 });
    const b = bootstrapMeanCI(values, { seed: 7, iterations: 500 });
    expect(a).toEqual(b);
  });

  it('different seeds can produce different (but close) resampling distributions', () => {
    const values = [0.1, 0.2, -0.05, 0.15, 0.0, 0.12, 0.08];
    const a = bootstrapMeanCI(values, { seed: 1, iterations: 500 });
    const b = bootstrapMeanCI(values, { seed: 2, iterations: 500 });
    expect(a!.mean).toBeCloseTo(b!.mean, 10); // observed mean is seed-independent
  });

  it('a real, consistent delta produces a CI that excludes zero', () => {
    const values = Array.from({ length: 50 }, (_, i) => 0.15 + ((i % 5) - 2) * 0.01); // centered at 0.15, small jitter
    const ci = bootstrapMeanCI(values, { seed: 42, iterations: 2000 })!;
    expect(ci.ciLow).toBeGreaterThan(0);
  });

  it('noise centered at zero produces a CI that includes zero', () => {
    const values = [0.05, -0.04, 0.03, -0.06, 0.02, -0.02, 0.04, -0.05, 0.01, -0.01];
    const ci = bootstrapMeanCI(values, { seed: 42, iterations: 2000 })!;
    expect(ci.ciLow).toBeLessThanOrEqual(0);
    expect(ci.ciHigh).toBeGreaterThanOrEqual(0);
  });
});

describe('decidePairedSignificance', () => {
  function delta(qaId: string, d: number, category: 1 | 2 | 3 | 4 | 5 = 4): PairedDelta {
    return { qaId, category, meanA: d, meanB: 0, delta: d };
  }

  it('INCONCLUSIVE when either side has too few repeats, regardless of the data', () => {
    const deltas = Array.from({ length: 20 }, (_, i) => delta(`q${i}`, 0.2));
    const result = decidePairedSignificance(deltas, { repeatsA: 2, repeatsB: 3, minRepeats: 3 });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toMatch(/too few repeats/);
  });

  it('INCONCLUSIVE with no paired questions', () => {
    const result = decidePairedSignificance([], { repeatsA: 5, repeatsB: 5 });
    expect(result.verdict).toBe('INCONCLUSIVE');
    expect(result.reason).toMatch(/no paired questions/);
  });

  it('SIGNIFICANT for a real, consistent delta with enough repeats', () => {
    const deltas = Array.from({ length: 60 }, (_, i) => delta(`q${i}`, 0.15 + ((i % 7) - 3) * 0.01));
    const result = decidePairedSignificance(deltas, { repeatsA: 5, repeatsB: 5, seed: 42, iterations: 3000 });
    expect(result.verdict).toBe('SIGNIFICANT');
    expect(result.delta).toBeGreaterThan(0);
  });

  it('NOT_SIGNIFICANT for a within-noise delta with enough repeats', () => {
    const jitters = [0.03, -0.02, 0.01, -0.04, 0.02, -0.01, 0.04, -0.03, 0.0, -0.02];
    const deltas = jitters.map((d, i) => delta(`q${i}`, d));
    const result = decidePairedSignificance(deltas, { repeatsA: 5, repeatsB: 5, seed: 42, iterations: 3000 });
    expect(result.verdict).toBe('NOT_SIGNIFICANT');
  });
});

describe('decidePairedSignificanceByCategory', () => {
  it('computes a verdict independently per category', () => {
    const deltas: PairedDelta[] = [
      ...Array.from({ length: 30 }, (_, i) => ({ qaId: `mh${i}`, category: 1 as const, meanA: 0.2, meanB: 0, delta: 0.2 + ((i % 5) - 2) * 0.01 })),
      ...Array.from({ length: 30 }, (_, i) => ({ qaId: `sh${i}`, category: 4 as const, meanA: 0, meanB: 0, delta: ((i % 5) - 2) * 0.01 })),
    ];
    const result = decidePairedSignificanceByCategory(deltas, { repeatsA: 5, repeatsB: 5, seed: 42, iterations: 3000 });
    expect(result[1].verdict).toBe('SIGNIFICANT');
    expect(result[4].verdict).toBe('NOT_SIGNIFICANT');
    expect(result[2].verdict).toBe('INCONCLUSIVE'); // no category-2 questions at all
    expect(result[2].reason).toMatch(/no paired questions/);
  });
});

describe('formatVerdict', () => {
  it('renders SIGNIFICANT with delta and CI', () => {
    const s = formatVerdict({ verdict: 'SIGNIFICANT', delta: 0.15, n: 40, ci: { mean: 0.15, ciLow: 0.05, ciHigh: 0.25, n: 40, iterations: 2000, alpha: 0.05 } });
    expect(s).toMatch(/^SIGNIFICANT \(Δ=\+15\.00%, CI \[\+5\.00%, \+25\.00%\], n=40\)$/);
  });

  it('renders NOT SIGNIFICANT with delta and CI', () => {
    const s = formatVerdict({ verdict: 'NOT_SIGNIFICANT', delta: 0.01, n: 40, ci: { mean: 0.01, ciLow: -0.05, ciHigh: 0.07, n: 40, iterations: 2000, alpha: 0.05 } });
    expect(s).toMatch(/^NOT SIGNIFICANT \(Δ=\+1\.00% within noise, CI \[-5\.00%, \+7\.00%\], n=40\)$/);
  });

  it('renders INCONCLUSIVE with the reason', () => {
    const s = formatVerdict({ verdict: 'INCONCLUSIVE', delta: NaN, n: 0, ci: null, reason: 'too few repeats for a trustworthy per-question mean (need >= 3 per config; got A=2, B=3)' });
    expect(s).toBe('INCONCLUSIVE (too few repeats for a trustworthy per-question mean (need >= 3 per config; got A=2, B=3))');
  });
});
