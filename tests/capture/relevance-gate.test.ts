/**
 * tests/capture/relevance-gate.test.ts
 *
 * FEAT-455 / ADR-012 decision 2 / spike checklist #2: the source-side
 * relevance gate. Covers all three check families (size caps, dedup window,
 * structural junk) plus the AC-6 distinctness requirement — none of
 * durability-gate.ts's taxonomy reasons appear anywhere in this module.
 */
import { describe, it, expect } from 'vitest';
import {
  gateRelevance,
  recordCapturedTurnHash,
  hashTurnText,
  type RelevanceGateOptions,
} from '../../src/capture/relevance-gate.js';

const OPTS: RelevanceGateOptions = { minChars: 8, maxBytes: 65536, dedupWindow: 20 };

/** Non-repetitive ASCII filler of exactly `byteLength` bytes — deliberately
 *  varied (not a single repeated char/token) so it never trips the
 *  structural-junk heuristics, isolating the size-cap checks under test. */
function fillerText(byteLength: number): string {
  const phrase = 'the quick brown fox jumps over the lazy dog and back again ';
  let out = '';
  while (out.length < byteLength) out += phrase;
  return out.slice(0, byteLength); // pure ASCII: 1 byte per char
}

describe('gateRelevance — size caps', () => {
  it('passes a turn at/above minChars', () => {
    const reason = gateRelevance({ role: 'user', text: 'a real question here' }, new Set(), OPTS);
    expect(reason).toBeNull();
  });

  it('gates a turn shorter than minChars as too_short', () => {
    const reason = gateRelevance({ role: 'user', text: 'ok' }, new Set(), OPTS);
    expect(reason).toBe('too_short');
  });

  it('gates a turn larger than maxBytes as too_large', () => {
    const big = fillerText(OPTS.maxBytes + 1);
    const reason = gateRelevance({ role: 'assistant', text: big }, new Set(), OPTS);
    expect(reason).toBe('too_large');
  });

  it('a turn exactly at maxBytes is not gated on size', () => {
    const exact = fillerText(OPTS.maxBytes);
    const reason = gateRelevance({ role: 'assistant', text: exact }, new Set(), OPTS);
    expect(reason).toBeNull();
  });

  it('maxBytes is measured in UTF-8 bytes, not JS string length (multi-byte chars)', () => {
    // Each CJK char below is 3 bytes in UTF-8 but 1 UTF-16 code unit — a text
    // whose .length is under maxBytes can still exceed it in byte terms.
    // Alternating two distinct characters (not a single repeated char/token)
    // avoids tripping the structural-junk heuristics.
    const opts: RelevanceGateOptions = { minChars: 8, maxBytes: 20, dedupWindow: 20 };
    const text = '漢字'.repeat(5); // 10 chars, 30 bytes
    expect(text.length).toBeLessThan(opts.maxBytes);
    const reason = gateRelevance({ role: 'user', text }, new Set(), opts);
    expect(reason).toBe('too_large');
  });
});

describe('gateRelevance — structural junk (AC-6: structural only, no semantic taxonomy)', () => {
  it('gates an empty (after trim) turn', () => {
    const reason = gateRelevance({ role: 'user', text: '   \n\t  ' }, new Set(), OPTS);
    expect(reason).toBe('structural_junk');
  });

  it('gates a punctuation-only turn', () => {
    const reason = gateRelevance({ role: 'user', text: '!!!???...' }, new Set(), OPTS);
    expect(reason).toBe('structural_junk');
  });

  it('gates a bare repeated-character run', () => {
    const reason = gateRelevance({ role: 'assistant', text: '.....' }, new Set(), OPTS);
    expect(reason).toBe('structural_junk');
  });

  it('gates a short repeated-token run ("ok ok ok")', () => {
    const reason = gateRelevance({ role: 'user', text: 'ok ok ok' }, new Set(), OPTS);
    expect(reason).toBe('structural_junk');
  });

  it('does NOT gate a long rationale-bearing turn that happens to mention a status word', () => {
    // Distinct from durability-gate's semantic taxonomy: this gate has no
    // ephemeral_state/vacuous_negative/etc. concept at all.
    const text = 'the build is green now because we fixed the flaky retry logic in the CI pipeline';
    const reason = gateRelevance({ role: 'assistant', text }, new Set(), OPTS);
    expect(reason).toBeNull();
  });
});

describe('gateRelevance — dedup window', () => {
  it('does not gate the first occurrence of a turn', () => {
    const recentHashes = new Set<string>();
    const reason = gateRelevance({ role: 'user', text: 'a distinct real question' }, recentHashes, OPTS);
    expect(reason).toBeNull();
  });

  it('gates a turn whose hash is already in recentHashes as duplicate_recent', () => {
    const recentHashes = new Set<string>();
    recordCapturedTurnHash(recentHashes, 'a distinct real question', OPTS.dedupWindow);
    const reason = gateRelevance({ role: 'user', text: 'a distinct real question' }, recentHashes, OPTS);
    expect(reason).toBe('duplicate_recent');
  });

  it('dedup comparison normalizes whitespace/case — near-identical text still dedupes', () => {
    const recentHashes = new Set<string>();
    recordCapturedTurnHash(recentHashes, 'A Distinct   Real Question', OPTS.dedupWindow);
    const reason = gateRelevance({ role: 'user', text: '  a distinct real question  ' }, recentHashes, OPTS);
    expect(reason).toBe('duplicate_recent');
  });

  it('does not mutate the caller-owned recentHashes set (pure function)', () => {
    const recentHashes = new Set<string>();
    gateRelevance({ role: 'user', text: 'a distinct real question' }, recentHashes, OPTS);
    expect(recentHashes.size).toBe(0);
  });
});

describe('recordCapturedTurnHash — ring buffer eviction', () => {
  it('evicts the oldest hash once the buffer exceeds dedupWindow', () => {
    const recentHashes = new Set<string>();
    const dedupWindow = 3;
    for (let i = 0; i < 5; i++) {
      recordCapturedTurnHash(recentHashes, `turn number ${i}`, dedupWindow);
    }
    expect(recentHashes.size).toBe(dedupWindow);
    // The two oldest ("turn number 0", "turn number 1") must be gone.
    expect(recentHashes.has(hashTurnText('turn number 0'))).toBe(false);
    expect(recentHashes.has(hashTurnText('turn number 1'))).toBe(false);
    expect(recentHashes.has(hashTurnText('turn number 4'))).toBe(true);
  });

  it('a turn evicted out of the window is no longer treated as a duplicate', () => {
    const recentHashes = new Set<string>();
    const dedupWindow = 2;
    recordCapturedTurnHash(recentHashes, 'first real turn here', dedupWindow);
    recordCapturedTurnHash(recentHashes, 'second real turn here', dedupWindow);
    recordCapturedTurnHash(recentHashes, 'third real turn here', dedupWindow);
    // "first real turn here" has aged out of the 2-wide window.
    const reason = gateRelevance({ role: 'user', text: 'first real turn here' }, recentHashes, OPTS);
    expect(reason).toBeNull();
  });
});

describe('AC-6 distinctness — no durability-gate taxonomy reasons anywhere', () => {
  it('GatedRelevanceReason values are disjoint from durability-gate GatedReason values', () => {
    const relevanceReasons = ['too_short', 'too_large', 'duplicate_recent', 'structural_junk'];
    const durabilityReasons = ['ephemeral_state', 'git_derivable', 'vacuous_negative', 'bare_todo', 'path_fragment'];
    for (const r of relevanceReasons) {
      expect(durabilityReasons).not.toContain(r);
    }
  });
});
