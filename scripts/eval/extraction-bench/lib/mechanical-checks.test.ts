import { describe, it, expect } from 'vitest';
import {
  findForbiddenItemHits,
  applyForbiddenItemScoring,
  computeEvidenceAccuracy,
  fixtureTranscriptText,
  normalizeClaimText,
} from './mechanical-checks.js';
import type { JudgeAtomIn, FixtureScore } from './judge.js';

function atom(type: string, text: string, evidence?: string | null): JudgeAtomIn {
  return { type, text, ...(evidence !== undefined ? { evidence } : {}) };
}

function baseScore(overrides: Partial<FixtureScore> = {}): FixtureScore {
  return {
    fixtureId: 'fx-test',
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

describe('normalizeClaimText', () => {
  it('lowercases, collapses whitespace, and strips light punctuation', () => {
    expect(normalizeClaimText("The V1 API is  STILL supported!")).toBe('the v1 api is still supported');
  });
});

describe('findForbiddenItemHits (AC-2)', () => {
  it('matches a full-claim forbidden item against the extracted atom that restates it', () => {
    const atoms = [
      atom('fact', 'The session store uses Redis for session storage.'),
      atom('fact', 'The session store does NOT use Redis — plain in-process LRU cache.'),
    ];
    const hits = findForbiddenItemHits(atoms, ['The session store uses Redis for session storage']);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.atomIndex).toBe(0);
  });

  it('is case/whitespace/punctuation insensitive', () => {
    const atoms = [atom('fact', "the   V1 api IS still supported!!")];
    const hits = findForbiddenItemHits(atoms, ['the v1 api is still supported']);
    expect(hits).toHaveLength(1);
  });

  // AC-6: the adversarial substring case — a bare/short forbidden phrase must
  // NOT trigger against an unrelated, legitimately different atom that merely
  // contains the same word as part of different durable content.
  it('AC-6: a bare short forbidden phrase ("Friday") does NOT false-positive inside a much longer, legitimately different atom', () => {
    const atoms = [
      atom('fact', 'The release after v3 is still planned for its normal Friday slot in the release cadence.'),
    ];
    const hits = findForbiddenItemHits(atoms, ['Friday']);
    expect(hits).toHaveLength(0);
  });

  it('AC-6: the SAME bare phrase still matches when it dominates a short atom (not just any co-occurrence)', () => {
    const atoms = [atom('fact', 'Friday')];
    const hits = findForbiddenItemHits(atoms, ['Friday']);
    expect(hits).toHaveLength(1);
  });

  it('a full-sentence forbidden item still matches even though it also contains a common short word', () => {
    const atoms = [atom('fact', 'The v3 release is scheduled for Friday.')];
    const hits = findForbiddenItemHits(atoms, ['The v3 release is scheduled for Friday']);
    expect(hits).toHaveLength(1);
  });

  it('returns no hits when forbidden_items is empty or atoms is empty', () => {
    expect(findForbiddenItemHits([], ['anything'])).toHaveLength(0);
    expect(findForbiddenItemHits([atom('fact', 'x')], [])).toHaveLength(0);
  });
});

describe('applyForbiddenItemScoring (AC-2)', () => {
  it('returns the original score unchanged (same reference) when there are no forbidden_items', () => {
    const score = baseScore();
    const atoms = [atom('fact', 'anything')];
    const result = applyForbiddenItemScoring(score, atoms, undefined);
    expect(result.score).toBe(score);
    expect(result.hits).toHaveLength(0);
  });

  it('penalizes precision for a forbidden-item hit the judge did NOT already flag as junk', () => {
    const atoms = [
      atom('fact', 'The v1 API is still supported.'), // forbidden — judge thought this was a genuine match
      atom('fact', 'v2 is the only supported API surface.'),
    ];
    const score = baseScore({
      extractedCount: 2,
      precision: 1, // judge saw no junk at all
      judge: {
        extracted_verdicts: [
          { index: 0, verdict: 'matches_gold', matched_gold_index: 0, type_correct: true, reason: 'r' },
          { index: 1, verdict: 'reasonable_extra', matched_gold_index: null, type_correct: null, reason: 'r' },
        ],
        unmatched_gold_indices: [],
      },
    });
    const { score: adjusted, hits } = applyForbiddenItemScoring(score, atoms, ['The v1 API is still supported']);
    expect(hits).toHaveLength(1);
    expect(adjusted.precision).toBeCloseTo(0.5, 10); // 1 of 2 atoms now fails
  });

  it('does not double-count an atom the judge already marked junk AND that also matches forbidden_items', () => {
    const atoms = [atom('fact', 'The v1 API is still supported.')];
    const score = baseScore({
      extractedCount: 1,
      precision: 0, // judge already flagged it junk -> precision already 0
      judge: {
        extracted_verdicts: [{ index: 0, verdict: 'junk', matched_gold_index: null, type_correct: null, reason: 'r' }],
        unmatched_gold_indices: [],
      },
    });
    const { score: adjusted } = applyForbiddenItemScoring(score, atoms, ['The v1 API is still supported']);
    expect(adjusted.precision).toBe(0); // unchanged — same single failing atom, not double-penalized
  });
});

describe('computeEvidenceAccuracy (AC-3)', () => {
  const transcript = fixtureTranscriptText([
    { text: 'we are NOT using Redis for the session store' },
    { text: 'plain in-process LRU cache for now' },
  ]);

  it('counts a real verbatim (whitespace-normalized) quote as accurate', () => {
    const atoms = [atom('fact', 'no Redis', 'we are NOT using Redis for the session store')];
    const result = computeEvidenceAccuracy(atoms, transcript);
    expect(result).toEqual({ numerator: 1, denominator: 1 });
  });

  it('tolerates whitespace differences but not a fabricated quote', () => {
    const atoms = [
      atom('fact', 'a', 'we are NOT using   Redis   for the session store'), // extra whitespace, still real
      atom('fact', 'b', 'we definitely ARE using Redis'), // fabricated — never said this
    ];
    const result = computeEvidenceAccuracy(atoms, transcript);
    expect(result).toEqual({ numerator: 1, denominator: 2 });
  });

  it('excludes atoms with no evidence field from the denominator entirely (AC-3) — not scored as a failure', () => {
    const atoms = [atom('fact', 'a'), atom('fact', 'b', ''), atom('fact', 'c', undefined)];
    const result = computeEvidenceAccuracy(atoms, transcript);
    expect(result).toEqual({ numerator: 0, denominator: 0 });
  });
});

describe('fixtureTranscriptText', () => {
  it('joins turn texts in order with newlines', () => {
    expect(fixtureTranscriptText([{ text: 'a' }, { text: 'b' }])).toBe('a\nb');
  });
});
