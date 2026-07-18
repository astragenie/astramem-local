import { describe, it, expect } from 'vitest';
import { checkEvidenceGate } from '../../src/distill/evidence-gate.js';
import { normalizeWhitespace, verifyEvidenceQuote } from '../../src/distill/evidence-verify.js';
// AC-3: the bench's own measurement function, imported directly (not
// reimplemented) so this test proves the two call sites agree on a SHARED
// fixture rather than merely both happening to be correct independently.
import { computeEvidenceAccuracy, fixtureTranscriptText } from '../../scripts/eval/extraction-bench/lib/mechanical-checks.js';

describe('verifyEvidenceQuote / normalizeWhitespace (FEAT-542/FEAT-551 shared util)', () => {
  it('counts a real verbatim (whitespace-normalized) quote as verified', () => {
    const transcript = 'we are NOT using Redis for the session store';
    expect(verifyEvidenceQuote('we are NOT using Redis for the session store', transcript)).toBe(true);
  });

  it('tolerates whitespace differences but not a fabricated quote', () => {
    const transcript = 'we are NOT using Redis for the session store';
    expect(verifyEvidenceQuote('we are NOT using   Redis   for the session store', transcript)).toBe(true);
    expect(verifyEvidenceQuote('we definitely ARE using Redis', transcript)).toBe(false);
  });

  it('an empty/whitespace-only quote never verifies', () => {
    expect(verifyEvidenceQuote('', 'anything at all')).toBe(false);
    expect(verifyEvidenceQuote('   ', 'anything at all')).toBe(false);
  });

  it('normalizeWhitespace trims and collapses internal runs, without lowercasing/stripping punctuation', () => {
    expect(normalizeWhitespace('  a   b\n\tc  ')).toBe('a b c');
    expect(normalizeWhitespace('Redis!')).toBe('Redis!');
  });
});

describe('checkEvidenceGate (FEAT-551 AC-1/AC-2)', () => {
  const transcript = 'we are NOT using Redis for the session store\nplain in-process LRU cache for now';

  it('AC-2: a pass-A atom is ALWAYS admitted, regardless of evidence', () => {
    expect(checkEvidenceGate({ extractionSource: 'passA' }, transcript)).toEqual({ admitted: true, reason: null });
    expect(checkEvidenceGate({ extractionSource: 'passA', evidence: 'fabricated, never said' }, transcript))
      .toEqual({ admitted: true, reason: null });
  });

  it('AC-2: an atom with no extractionSource tag (single-pass run) is ALWAYS admitted', () => {
    expect(checkEvidenceGate({}, transcript)).toEqual({ admitted: true, reason: null });
    expect(checkEvidenceGate({ evidence: 'fabricated, never said' }, transcript)).toEqual({ admitted: true, reason: null });
  });

  it('AC-1: a passB atom with no evidence field is dropped — no-evidence-field', () => {
    expect(checkEvidenceGate({ extractionSource: 'passB' }, transcript))
      .toEqual({ admitted: false, reason: 'no-evidence-field' });
  });

  it('AC-1: a passB atom with an empty/whitespace-only evidence field is dropped — no-evidence-field', () => {
    expect(checkEvidenceGate({ extractionSource: 'passB', evidence: '   ' }, transcript))
      .toEqual({ admitted: false, reason: 'no-evidence-field' });
  });

  it('AC-1: a passB atom whose evidence does not mechanically verify is dropped — evidence-not-found', () => {
    expect(checkEvidenceGate({ extractionSource: 'passB', evidence: 'we definitely ARE using Redis' }, transcript))
      .toEqual({ admitted: false, reason: 'evidence-not-found' });
  });

  it('AC-1: a passB atom whose evidence verifies (whitespace-normalized) is admitted', () => {
    expect(checkEvidenceGate({ extractionSource: 'passB', evidence: 'we are NOT using   Redis   for the session store' }, transcript))
      .toEqual({ admitted: true, reason: null });
  });

  it('a passB atom is dropped (evidence-not-found) when there is no transcript to verify against', () => {
    expect(checkEvidenceGate({ extractionSource: 'passB', evidence: 'we are NOT using Redis for the session store' }, undefined))
      .toEqual({ admitted: false, reason: 'evidence-not-found' });
  });
});

// AC-3: "a test asserts the bench's computeEvidenceAccuracy and the
// production gate agree on at least one shared fixture" — closes the exact
// bench/src drift risk named in FEAT-551's own spec and pre-mortem.
describe('AC-3: bench (computeEvidenceAccuracy) and production gate (checkEvidenceGate) agree', () => {
  const transcript = fixtureTranscriptText([
    { text: 'we are NOT using Redis for the session store' },
    { text: 'plain in-process LRU cache for now' },
  ]);

  const cases: Array<{ label: string; evidence: string | undefined }> = [
    { label: 'real verbatim quote', evidence: 'we are NOT using Redis for the session store' },
    { label: 'real quote with extra whitespace', evidence: 'we are NOT using   Redis   for the session store' },
    { label: 'fabricated quote', evidence: 'we definitely ARE using Redis' },
    { label: 'no evidence at all', evidence: undefined },
  ];

  for (const { label, evidence } of cases) {
    it(`${label}: bench accuracy and gate admission agree`, () => {
      const benchResult = computeEvidenceAccuracy(
        [{ type: 'fact', text: 'irrelevant', ...(evidence !== undefined ? { evidence } : {}) }],
        transcript,
      );
      const gateResult = checkEvidenceGate({ extractionSource: 'passB', evidence }, transcript);

      if (evidence === undefined) {
        // Bench excludes no-evidence atoms from its denominator entirely;
        // the gate's distinct verdict for the same case is "no-evidence-field".
        expect(benchResult).toEqual({ numerator: 0, denominator: 0 });
        expect(gateResult).toEqual({ admitted: false, reason: 'no-evidence-field' });
      } else {
        // Bench counted it (denominator 1) — whether it was accurate
        // (numerator 1) must agree exactly with whether the gate admits it.
        expect(benchResult.denominator).toBe(1);
        const benchConsideredAccurate = benchResult.numerator === 1;
        expect(gateResult.admitted).toBe(benchConsideredAccurate);
      }
    });
  }
});
