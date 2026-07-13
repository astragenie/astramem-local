/**
 * The validity guard (issue #205 follow-up).
 *
 * PR #216 wired the extraction model's `invalid_at` straight into the bitemporal
 * `memories.valid_to` column with no validation of any kind:
 *
 *     invalid_at: z.string().optional()          // not a date. any string.
 *     valid_to:   parseIsoToMs(mem.invalid_at)   // Date.parse. accepts "9999".
 *
 * Combined with `validityFilterClause`'s default predicate, a `valid_to` in the
 * past makes the atom fail every normal recall — permanently, silently, with a
 * successful write and a green canary. One bad token from a 7B model deletes a
 * real memory from search.
 *
 * The guard's contract: KEEP THE ATOM, DROP THE BOUND. Never the atom. An
 * unbounded atom is merely imprecise; a wrongly-bounded atom is gone.
 */
import { describe, it, expect } from 'vitest';
import { guardValidTo } from '../../src/distill/stages/08-embed-index.js';

const JAN_2026 = Date.parse('2026-01-15T00:00:00Z');

describe('guardValidTo — an implausible bound must never reach valid_to', () => {
  it('passes a plausible end date through untouched', () => {
    const march2027 = Date.parse('2027-03-01T00:00:00Z');
    expect(guardValidTo(march2027, JAN_2026, JAN_2026)).toEqual({
      validTo: march2027,
      dropped: null,
    });
  });

  it('absent invalid_at means unbounded, not dropped', () => {
    expect(guardValidTo(null, JAN_2026, JAN_2026)).toEqual({ validTo: null, dropped: null });
  });

  it('year 9999 — the canonical hallucination — is refused, atom kept unbounded', () => {
    const year9999 = Date.parse('9999-01-01T00:00:00Z');
    expect(guardValidTo(year9999, JAN_2026, JAN_2026)).toEqual({
      validTo: null,
      dropped: 'invalid_at_implausible',
    });
  });

  it('a far-past date is refused — this is the one that DELETES the memory', () => {
    // A valid_to in the deep past means the atom fails
    // `(valid_to IS NULL OR valid_to > now)` on every default recall — it is
    // stored, reports success, and is never retrievable again.
    //
    // Refused as `invalid_at_before_valid_at` rather than `..._implausible`:
    // the ordering check runs first and a far-past date trips it too. Either
    // reason is a refusal, and the refusal is what protects the memory — but
    // assert the reason the code actually reports, not the one it "should"
    // report, or this test is fiction.
    const year1900 = Date.parse('1900-01-01T00:00:00Z');
    expect(guardValidTo(year1900, JAN_2026, JAN_2026)).toEqual({
      validTo: null,
      dropped: 'invalid_at_before_valid_at',
    });
  });

  it('a far-past date with NO valid_at still trips the plausibility bound', () => {
    // With no start bound to compare against, the ordering check cannot fire —
    // the plausibility window is the only thing standing between a hallucinated
    // 1900 and a permanently-unretrievable memory.
    const year1900 = Date.parse('1900-01-01T00:00:00Z');
    expect(guardValidTo(year1900, null, JAN_2026)).toEqual({
      validTo: null,
      dropped: 'invalid_at_implausible',
    });
  });

  it('an interval that ends before it starts is empty — refused', () => {
    // Invisible even to an `as_of` query. Always garbage, never intentional.
    const before = Date.parse('2025-01-01T00:00:00Z');
    expect(guardValidTo(before, JAN_2026, JAN_2026)).toEqual({
      validTo: null,
      dropped: 'invalid_at_before_valid_at',
    });
  });

  it('invalid_at exactly equal to valid_at is an empty interval — refused', () => {
    expect(guardValidTo(JAN_2026, JAN_2026, JAN_2026)).toEqual({
      validTo: null,
      dropped: 'invalid_at_before_valid_at',
    });
  });

  it('a genuinely long but real window (25-year contract) is NOT refused', () => {
    // The guard catches year-9999, not plausible business dates. A false reject
    // costs a real bound; the window is deliberately generous.
    const y2051 = Date.parse('2051-01-01T00:00:00Z');
    expect(guardValidTo(y2051, JAN_2026, JAN_2026).dropped).toBeNull();
  });
});
