import { describe, it, expect } from 'vitest';
import { fuseScores, normalizeScores } from '../../src/search/fuse.js';

describe('normalizeScores', () => {
  it('scales values into [0,1]', () => {
    const out = normalizeScores([0, 5, 10]);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(1);
  });

  it('all-same → all 0', () => {
    const out = normalizeScores([3, 3, 3]);
    expect(out).toEqual([0, 0, 0]);
  });

  it('empty array → empty', () => {
    expect(normalizeScores([])).toEqual([]);
  });
});

describe('fuseScores', () => {
  it('bm25=0 cosine=1 importance=1 freshness=1 → β + γ + δ', () => {
    // Defaults: α=0.4 β=0.4 γ=0.1 δ=0.1
    // score = α·0 + β·1 + γ·1 + δ·1 = 0.4 + 0.1 + 0.1 = 0.6
    const score = fuseScores({
      normBm25: 0,
      normCosine: 1,
      importance: 1,
      freshness: 1,
      alpha: 0.4,
      beta: 0.4,
      gamma: 0.1,
      delta: 0.1
    });
    expect(score).toBeCloseTo(0.6);
  });

  it('all 1 → sum of weights = 1.0', () => {
    const score = fuseScores({
      normBm25: 1,
      normCosine: 1,
      importance: 1,
      freshness: 1,
      alpha: 0.4,
      beta: 0.4,
      gamma: 0.1,
      delta: 0.1
    });
    expect(score).toBeCloseTo(1.0);
  });

  it('all 0 → 0', () => {
    const score = fuseScores({
      normBm25: 0,
      normCosine: 0,
      importance: 0,
      freshness: 0,
      alpha: 0.4,
      beta: 0.4,
      gamma: 0.1,
      delta: 0.1
    });
    expect(score).toBeCloseTo(0);
  });

  it('bm25-only path: bm25=1 cosine=0 importance=0 freshness=0 → α', () => {
    const score = fuseScores({
      normBm25: 1,
      normCosine: 0,
      importance: 0,
      freshness: 0,
      alpha: 0.4,
      beta: 0.4,
      gamma: 0.1,
      delta: 0.1
    });
    expect(score).toBeCloseTo(0.4);
  });
});
