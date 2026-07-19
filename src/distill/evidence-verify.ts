/**
 * Mechanical (judge-free) evidence-quote verification — FEAT-542/FEAT-551
 * single-source-of-truth.
 *
 * Originally lived only inside the extraction bench's `computeEvidenceAccuracy`
 * (scripts/eval/extraction-bench/lib/mechanical-checks.ts, FEAT-542). FEAT-551's
 * stage-8 production admission gate (src/distill/evidence-gate.ts) needs the
 * EXACT SAME quote-verification logic — a hallucinated passB atom is only
 * unsafe to admit if the bench and the gate could ever disagree about whether
 * a quote "really" appears in the transcript. Promoting the check to this
 * shared util (and having the bench import it back) closes that drift risk
 * by construction: there is exactly one implementation, not two that must be
 * kept in sync by hand. See tests/distill/evidence-gate.test.ts's
 * "bench/gate agreement" case, which asserts both call sites agree on a
 * shared fixture (AC-3).
 *
 * FEAT-552 sub-scope C (AC-C2): added a token-window FUZZY fallback tier,
 * tried only after the exact whitespace-normalized substring check above
 * fails. Measured basis: 18 `evidence-not-found` gate drops in the FEAT-551
 * run include near-misses (whitespace/ellipsis variants) that are real
 * quotes a human would recognize instantly but the exact-substring check
 * rejects. `verifyEvidenceQuote` (the boolean the bench's
 * `computeEvidenceAccuracy` already delegates to) now tries exact THEN
 * fuzzy internally — the ONE-implementation rule this module's own doc
 * comment above describes means the bench inherits the fuzzy tier for free,
 * with no separate wiring. Callers that need to know WHICH tier admitted a
 * quote (the production gate, for distinct-reason observability) call
 * `verifyEvidenceQuoteTier` directly instead.
 */

/**
 * Trim + collapse internal whitespace runs to a single space. Deliberately
 * NOT lowercasing and NOT stripping punctuation — a fabricated-but-similar
 * quote must never count as real evidence, only a true (modulo whitespace)
 * verbatim match.
 */
export function normalizeWhitespace(s: string): string {
  return s.trim().replace(/\s+/g, ' ');
}

/** Minimum fraction of the quote's own tokens that must appear (as a
 *  multiset) inside a same-length sliding window of the transcript for the
 *  fuzzy tier to pass (AC-C2's literal ">=90% token overlap"). */
const FUZZY_TOKEN_OVERLAP_MIN = 0.9;

/** Split on whitespace runs (already-normalized input assumed — see callers
 *  below). Deliberately does NOT lowercase or strip punctuation, same
 *  case/punctuation-sensitivity `normalizeWhitespace` already documents for
 *  the exact tier — a fuzzy match that ignored case/punctuation entirely
 *  would blur the line between "near-miss" and "similar but different". */
function tokenize(normalized: string): string[] {
  return normalized.length === 0 ? [] : normalized.split(' ');
}

/**
 * Token-window best-match (FEAT-552 sub-scope C, AC-C2): slides a window the
 * same length as the quote's own token count across the transcript's
 * tokens, and passes as soon as one window's multiset overlap with the
 * quote's tokens reaches `FUZZY_TOKEN_OVERLAP_MIN`. Catches whitespace/
 * ellipsis/single-word near-misses an exact substring match rejects,
 * without opening the door to a genuinely fabricated quote — a fabricated
 * quote shares too few tokens with ANY window to ever clear 90%.
 */
function fuzzyTokenWindowMatch(quoteTokens: string[], transcriptTokens: string[]): boolean {
  const n = quoteTokens.length;
  if (n === 0 || transcriptTokens.length < n) return false;

  const quoteCounts = new Map<string, number>();
  for (const tok of quoteTokens) quoteCounts.set(tok, (quoteCounts.get(tok) ?? 0) + 1);

  for (let start = 0; start + n <= transcriptTokens.length; start++) {
    const windowCounts = new Map<string, number>();
    for (let i = start; i < start + n; i++) {
      const tok = transcriptTokens[i] as string;
      windowCounts.set(tok, (windowCounts.get(tok) ?? 0) + 1);
    }
    let overlap = 0;
    for (const [tok, qCount] of quoteCounts) {
      overlap += Math.min(qCount, windowCounts.get(tok) ?? 0);
    }
    if (overlap / n >= FUZZY_TOKEN_OVERLAP_MIN) return true;
  }
  return false;
}

export type EvidenceMatchTier = 'exact' | 'fuzzy' | 'none';

/**
 * Does `evidence` appear inside `transcriptText`, and via which tier?
 * Empty/whitespace-only evidence never verifies — always `'none'` (mirrors
 * the bench's own denominator-exclusion rule for an absent `evidence` field
 * — see `computeEvidenceAccuracy`'s doc comment). Tries the exact
 * whitespace-normalized substring match FIRST (unchanged FEAT-542/551
 * behavior); only on failure falls back to the FEAT-552 sub-scope C token-
 * window fuzzy match (AC-C2).
 */
export function verifyEvidenceQuoteTier(evidence: string, transcriptText: string): EvidenceMatchTier {
  const normQuote = normalizeWhitespace(evidence);
  if (normQuote.length === 0) return 'none';
  const normTranscript = normalizeWhitespace(transcriptText);
  if (normTranscript.includes(normQuote)) return 'exact';
  if (fuzzyTokenWindowMatch(tokenize(normQuote), tokenize(normTranscript))) return 'fuzzy';
  return 'none';
}

/**
 * Does `evidence` appear (exact OR fuzzy — see `verifyEvidenceQuoteTier`)
 * inside `transcriptText`? Boolean convenience wrapper every pre-FEAT-552
 * caller (the bench's `computeEvidenceAccuracy`, callers that don't need to
 * distinguish tiers) already uses — kept so the ONE-implementation rule
 * means the fuzzy tier is inherited automatically, no separate wiring.
 */
export function verifyEvidenceQuote(evidence: string, transcriptText: string): boolean {
  return verifyEvidenceQuoteTier(evidence, transcriptText) !== 'none';
}
