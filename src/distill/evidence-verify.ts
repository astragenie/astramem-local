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

/**
 * Does `evidence` appear, whitespace-normalized, inside `transcriptText`?
 * Empty/whitespace-only evidence never verifies (mirrors the bench's own
 * denominator-exclusion rule for an absent `evidence` field — see
 * `computeEvidenceAccuracy`'s doc comment — though callers deciding whether
 * to even ask this question for a no-evidence atom should treat that as its
 * own distinct case, e.g. FEAT-551's `no-evidence-field` drop reason, rather
 * than reading a `false` return here as "fabricated").
 */
export function verifyEvidenceQuote(evidence: string, transcriptText: string): boolean {
  const normQuote = normalizeWhitespace(evidence);
  if (normQuote.length === 0) return false;
  return normalizeWhitespace(transcriptText).includes(normQuote);
}
