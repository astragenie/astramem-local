import { describe, it, expect } from 'vitest';
import { fuseScores, normalizeScores, fuseHits } from '../../src/search/fuse.js';

describe('normalizeScores', () => {
  it('scales values into [0,1]', () => {
    const out = normalizeScores([0, 5, 10]);
    expect(out[0]).toBeCloseTo(0);
    expect(out[1]).toBeCloseTo(0.5);
    expect(out[2]).toBeCloseTo(1);
  });

  it('all-same non-empty → all 1.0 (equal scores are equally best; signal preserved)', () => {
    const out = normalizeScores([3, 3, 3]);
    expect(out).toEqual([1, 1, 1]);
  });

  it('single hit → 1.0 (a lone FTS/vec hit must not lose its component signal)', () => {
    expect(normalizeScores([7])).toEqual([1]);
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

  // FEAT-402 AC-6: zeta (entity-relevance bonus) — DEFAULT OFF, only
  // reshuffles when explicitly enabled.
  describe('zeta (entity bonus, AC-6)', () => {
    const base = {
      normBm25: 0.5, normCosine: 0.5, importance: 0.5, freshness: 0.5,
      alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1,
    };

    it('zeta omitted → entityBonus=1 contributes nothing (byte-identical to no zeta)', () => {
      const withoutZeta = fuseScores(base);
      const withEntityBonusButNoZeta = fuseScores({ ...base, entityBonus: 1 });
      expect(withEntityBonusButNoZeta).toBe(withoutZeta);
    });

    it('zeta=0 → entityBonus=1 still contributes nothing (explicit OFF, AC-6 default)', () => {
      const zetaZero = fuseScores({ ...base, zeta: 0, entityBonus: 1 });
      const noZeta = fuseScores(base);
      expect(zetaZero).toBe(noZeta);
    });

    it('zeta>0 with entityBonus=1 adds exactly zeta to the score', () => {
      const plain = fuseScores(base);
      const boosted = fuseScores({ ...base, zeta: 0.2, entityBonus: 1 });
      expect(boosted).toBeCloseTo(plain + 0.2);
    });

    it('zeta>0 with entityBonus=0 (or absent) contributes nothing', () => {
      const plain = fuseScores(base);
      expect(fuseScores({ ...base, zeta: 0.2, entityBonus: 0 })).toBeCloseTo(plain);
      expect(fuseScores({ ...base, zeta: 0.2 })).toBeCloseTo(plain);
    });
  });
});

describe('fuseHits — AC-6 zeta ranking safety', () => {
  // Fixed clock so freshness decay is deterministic — the two snapshot runs
  // below must share the same nowMs, otherwise a sub-ms delta between two
  // Date.now() calls perturbs freshness and flakes the exact-score assertion.
  const NOW = 1_700_000_000_000;
  const metas = new Map([
    ['a', { importance: 0.5, created_at: NOW }],
    ['b', { importance: 0.5, created_at: NOW }],
  ]);
  // Identical bm25/cosine for both candidates so, absent zeta, they tie —
  // any reshuffle at zeta>0 is attributable ONLY to the entity bonus term.
  const ftsHits = [{ id: 'a', bm25: -1 }, { id: 'b', bm25: -1 }];
  const vecHits = [{ id: 'a', cosine: 0.5 }, { id: 'b', cosine: 0.5 }];
  const weights = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1 };

  it('zeta=0 (default) → order identical whether or not an entityBonus map is supplied', () => {
    const withoutBonusMap = fuseHits(ftsHits, vecHits, metas, { ...weights, zeta: 0 }, NOW);
    const withBonusMapButZetaZero = fuseHits(
      ftsHits, vecHits, metas, { ...weights, zeta: 0 }, NOW, undefined, undefined,
      new Map([['b', 1]]),
    );
    expect(withBonusMapButZetaZero.map(h => h.id)).toEqual(withoutBonusMap.map(h => h.id));
    expect(withBonusMapButZetaZero.map(h => h.score)).toEqual(withoutBonusMap.map(h => h.score));
  });

  it('zeta>0 with a non-uniform entityBonus map changes ranking order', () => {
    const baseline = fuseHits(ftsHits, vecHits, metas, weights, NOW);
    // Tied candidates — baseline order is a tie; entityBonus must promote 'b'.
    expect(baseline.map(h => h.score)[0]).toBeCloseTo(baseline.map(h => h.score)[1] as number);

    const boosted = fuseHits(
      ftsHits, vecHits, metas, { ...weights, zeta: 0.5 }, NOW, undefined, undefined,
      new Map([['b', 1]]),
    );
    expect(boosted[0]?.id).toBe('b');
    expect(boosted[0]?.score).toBeGreaterThan(boosted[1]?.score as number);
  });
});
