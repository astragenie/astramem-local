import { describe, it, expect } from 'vitest';
import { fuseScores, normalizeScores, fuseHits } from '../../src/search/fuse.js';
import { defaultConfig } from '../../src/config/config.js';

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

    // Post-normalization (fuseScores divides by the sum of active weights,
    // see fuse.ts doc comment / wire-contract fix): turning zeta on changes
    // the active-weight sum for every candidate in the call, so the effect
    // of the entity bonus is no longer a flat "+zeta" — it's the bonus's
    // share of the new (larger) denominator. Values below are computed
    // explicitly rather than pinned as "plain + zeta" to make that visible.
    it('zeta>0 with entityBonus=1 raises the score by the bonus share of the active weight sum', () => {
      // base raw = 0.4*0.5 + 0.4*0.5 + 0.1*0.5 + 0.1*0.5 = 0.5, weightSum(no zeta) = 1.0 -> plain = 0.5
      const plain = fuseScores(base);
      expect(plain).toBeCloseTo(0.5);
      // boosted raw = 0.5 + 0.2*1 = 0.7, weightSum = 0.4+0.4+0.1+0.1+0.2 = 1.2 -> 0.7/1.2
      const boosted = fuseScores({ ...base, zeta: 0.2, entityBonus: 1 });
      expect(boosted).toBeCloseTo(0.7 / 1.2);
      expect(boosted).toBeGreaterThan(plain);
    });

    it('zeta>0 with entityBonus=0 (or absent) dilutes the other components via the larger weight sum', () => {
      // Turning zeta on (even with no bonus firing) grows the active weight
      // sum from 1.0 to 1.2, so the score is NOT unchanged — it's diluted:
      // raw stays 0.5, but weightSum grows to 1.2 -> 0.5/1.2 < 0.5.
      const plain = fuseScores(base);
      const diluted = fuseScores({ ...base, zeta: 0.2, entityBonus: 0 });
      expect(diluted).toBeCloseTo(0.5 / 1.2);
      expect(diluted).toBeLessThan(plain);
      expect(fuseScores({ ...base, zeta: 0.2 })).toBeCloseTo(0.5 / 1.2);
    });
  });

  // FEAT-426: eta (agent-match soft-boost) — structurally identical to zeta,
  // DEFAULT OFF, only reshuffles when explicitly enabled.
  describe('eta (agent-match soft-boost, FEAT-426)', () => {
    const base = {
      normBm25: 0.5, normCosine: 0.5, importance: 0.5, freshness: 0.5,
      alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1,
    };

    it('eta omitted → agentBonus=1 contributes nothing (byte-identical to no eta)', () => {
      const withoutEta = fuseScores(base);
      const withAgentBonusButNoEta = fuseScores({ ...base, agentBonus: 1 });
      expect(withAgentBonusButNoEta).toBe(withoutEta);
    });

    it('eta=0 → agentBonus=1 still contributes nothing (explicit OFF, FEAT-426 default)', () => {
      const etaZero = fuseScores({ ...base, eta: 0, agentBonus: 1 });
      const noEta = fuseScores(base);
      expect(etaZero).toBe(noEta);
    });

    it('eta>0 with agentBonus=1 raises the score by the bonus share of the active weight sum', () => {
      // base raw = 0.4*0.5 + 0.4*0.5 + 0.1*0.5 + 0.1*0.5 = 0.5, weightSum(no eta) = 1.0 -> plain = 0.5
      const plain = fuseScores(base);
      expect(plain).toBeCloseTo(0.5);
      // boosted raw = 0.5 + 0.2*1 = 0.7, weightSum = 0.4+0.4+0.1+0.1+0.2 = 1.2 -> 0.7/1.2
      const boosted = fuseScores({ ...base, eta: 0.2, agentBonus: 1 });
      expect(boosted).toBeCloseTo(0.7 / 1.2);
      expect(boosted).toBeGreaterThan(plain);
    });

    it('eta>0 with agentBonus=0 (or absent) dilutes the other components via the larger weight sum', () => {
      const plain = fuseScores(base);
      const diluted = fuseScores({ ...base, eta: 0.2, agentBonus: 0 });
      expect(diluted).toBeCloseTo(0.5 / 1.2);
      expect(diluted).toBeLessThan(plain);
      expect(fuseScores({ ...base, eta: 0.2 })).toBeCloseTo(0.5 / 1.2);
    });

    it('fused score stays <= 1 even with eta stacked on top of every other maxed component', () => {
      const maxed = fuseScores({
        normBm25: 1, normCosine: 1, importance: 1, freshness: 1,
        usefulness: 1, entityBonus: 1, agentBonus: 1,
        alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1, zeta: 0.1, eta: 0.1,
      });
      expect(maxed).toBeLessThanOrEqual(1);
      expect(maxed).toBeCloseTo(1); // raw == weightSum when every component + bonus is maxed
    });
  });
});

// Wire-contract regression (memory-plugin#8): the daemon's default weights
// (alpha=beta=0.4, gamma=delta=epsilon=0.1, zeta=0) sum to 1.1, not 1. Before
// the fix, fuseScores returned the raw weighted sum unnormalized, so a
// perfect-match, fresh, important, "used" memory scored ~1.04 — outside the
// plugin's Zod [0,1] range, causing recall to fail with exit 3. fuseScores
// must now normalize by the active weight sum so every score is <= 1.
describe('fuseScores wire-contract invariant (memory-plugin#8)', () => {
  it('perfect-storm input (all components maxed, default weights) stays within [0,1]', () => {
    const weights = defaultConfig().search; // alpha .4 beta .4 gamma .1 delta .1 epsilon .1 zeta 0 (sums to 1.1)
    const score = fuseScores({
      normBm25: 1,
      normCosine: 1,
      importance: 0.9,
      freshness: 1,
      usefulness: 1,
      entityBonus: 1,
      ...weights,
    });
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThan(0);
    // raw = 0.4+0.4+0.09+0.1+0.1+0 = 1.09, weightSum = 1.1 -> 1.09/1.1
    expect(score).toBeCloseTo(1.09 / 1.1);
  });

  it('degenerate all-zero weights returns 0 rather than dividing by zero', () => {
    const score = fuseScores({
      normBm25: 1, normCosine: 1, importance: 1, freshness: 1,
      alpha: 0, beta: 0, gamma: 0, delta: 0, epsilon: 0, zeta: 0,
    });
    expect(score).toBe(0);
  });

  it('future created_at (SaaS-sync clock skew) cannot push a score past 1', () => {
    const NOW = 1_700_000_000_000;
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;
    // created_at 30 days in the future: unclamped freshness would be e^1 ≈ 2.72
    const metas = new Map([['skewed', { importance: 1, created_at: NOW + THIRTY_DAYS }]]);
    const hits = fuseHits(
      [{ id: 'skewed', bm25: -1 }],
      [{ id: 'skewed', cosine: 1 }],
      metas,
      { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1 },
      NOW,
    );
    expect(hits).toHaveLength(1);
    expect(hits[0].score).toBeLessThanOrEqual(1);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('fuseScores output is hard-capped at 1 even if a component regresses past its bound', () => {
    // Defense-in-depth: feed a deliberately out-of-contract freshness (2.72).
    const score = fuseScores({
      normBm25: 1, normCosine: 1, importance: 1, freshness: 2.72,
      alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1,
    });
    expect(score).toBeLessThanOrEqual(1);
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

// FEAT-426 (soft-boost agent recall): eta/agentBonus is a rank-only concern —
// it must never change WHICH candidates appear (that's still the caller's
// job — either the SQL hard filter or "no filter at all"), only how the
// already-present candidate set is ORDERED.
describe('fuseHits — FEAT-426 eta ranking safety (rank changes, membership does not)', () => {
  const NOW = 1_700_000_000_000;
  const metas = new Map([
    ['a', { importance: 0.5, created_at: NOW }],
    ['b', { importance: 0.5, created_at: NOW }],
  ]);
  // Identical bm25/cosine for both candidates so, absent eta, they tie — any
  // reshuffle at eta>0 is attributable ONLY to the agent-match bonus term.
  const ftsHits = [{ id: 'a', bm25: -1 }, { id: 'b', bm25: -1 }];
  const vecHits = [{ id: 'a', cosine: 0.5 }, { id: 'b', cosine: 0.5 }];
  const weights = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1 };

  it('eta=0 (default) → order identical whether or not an agentBonus map is supplied', () => {
    const withoutBonusMap = fuseHits(ftsHits, vecHits, metas, { ...weights, eta: 0 }, NOW);
    const withBonusMapButEtaZero = fuseHits(
      ftsHits, vecHits, metas, { ...weights, eta: 0 }, NOW, undefined, undefined, undefined,
      new Map([['b', 1]]),
    );
    expect(withBonusMapButEtaZero.map(h => h.id)).toEqual(withoutBonusMap.map(h => h.id));
    expect(withBonusMapButEtaZero.map(h => h.score)).toEqual(withoutBonusMap.map(h => h.score));
  });

  it('eta>0 with a non-uniform agentBonus map changes rank but not membership', () => {
    const baseline = fuseHits(ftsHits, vecHits, metas, weights, NOW);
    // Tied candidates — baseline order is a tie; agentBonus must promote 'b'.
    expect(baseline.map(h => h.score)[0]).toBeCloseTo(baseline.map(h => h.score)[1] as number);
    const baselineIds = new Set(baseline.map(h => h.id));

    const boosted = fuseHits(
      ftsHits, vecHits, metas, { ...weights, eta: 0.5 }, NOW, undefined, undefined, undefined,
      new Map([['b', 1]]),
    );
    // Membership unchanged — same two candidates, neither added nor dropped.
    expect(new Set(boosted.map(h => h.id))).toEqual(baselineIds);
    // Rank changed — 'b' (the agent-matched candidate) now ranks first.
    expect(boosted[0]?.id).toBe('b');
    expect(boosted[0]?.score).toBeGreaterThan(boosted[1]?.score as number);
  });
});
