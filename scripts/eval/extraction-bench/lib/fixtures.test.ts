import { describe, it, expect } from 'vitest';
import { loadFixtures } from './fixtures.js';

const REQUIRED_NEW_DIFFICULTIES = ['negation', 'uncertainty', 'status-transition', 'cross-chunk'];

describe('loadFixtures (FEAT-542 AC-1)', () => {
  const fixtures = loadFixtures();

  it('loads 53+ fixtures total (43 pre-existing + >=10 new hard-fixture-pack additions)', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(53);
  });

  it('has at least 2 fixtures tagged with each of the 4 new difficulty tags', () => {
    for (const difficulty of REQUIRED_NEW_DIFFICULTIES) {
      const matching = fixtures.filter(f => f.difficulty === difficulty);
      expect(matching.length, `expected >=2 fixtures tagged difficulty:${difficulty}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every fixture has the same required schema shape as pre-existing fixtures (id/turns[]/gold_atoms[])', () => {
    for (const f of fixtures) {
      expect(typeof f.id).toBe('string');
      expect(Array.isArray(f.turns)).toBe(true);
      expect(Array.isArray(f.gold_atoms)).toBe(true);
      expect(typeof f.difficulty).toBe('string');
      // forbidden_items is optional and additive — when present, must be a string array.
      if (f.forbidden_items !== undefined) {
        expect(Array.isArray(f.forbidden_items)).toBe(true);
        for (const item of f.forbidden_items) expect(typeof item).toBe('string');
      }
    }
  });

  it('at least one new-difficulty fixture carries a non-empty forbidden_items array (AC-2 exercised by real fixture data)', () => {
    const negationFixtures = fixtures.filter(f => f.difficulty === 'negation');
    const withForbidden = negationFixtures.filter(f => (f.forbidden_items?.length ?? 0) > 0);
    expect(withForbidden.length).toBeGreaterThan(0);
  });
});
