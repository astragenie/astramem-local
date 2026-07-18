/**
 * FEAT-551 — evidence-gated sweeper: stage-8 admission gate for dual-pass
 * ("specifics sweeper", `distill.extractionPasses: 2`) passB atoms in the
 * mixed-provider case.
 *
 * Motivation (measured, 2026-07-17/18 LoCoMo experiment series): a raw
 * mixed-provider passB sweep (phi4-mini) measured ~100% recall on its own
 * narrow recall task, but LOST 5.8 points end-to-end — its junk atoms
 * crowded top-k retrieval (adversarial category alone dropped 14.9 points,
 * because junk atoms read as fake "evidence" for questions the answerer
 * should have abstained on). The fix is NOT better prompting or a second LLM
 * judge call on the hot admission path — it's a MECHANICAL gate: a passB
 * atom is only admitted to the store when its `evidence` quote verifiably
 * appears (whitespace-normalized) in the source transcript. A hallucinated
 * or free-floating atom has no verifying quote, so it can never reach the
 * index — junk cannot crowd retrieval if junk cannot enter (see FEAT-551's
 * spec, .claude/artifacts/loop/backlog/in-progress/FEAT-551.md).
 *
 * Pass-A atoms are NEVER gated here (AC-2) — this function's own
 * `extractionSource !== 'passB'` bypass is the enforcement point, so a
 * caller can safely call this unconditionally for every atom without
 * special-casing pass A. The CALLER (embedAndIndex,
 * src/distill/stages/08-embed-index.ts) additionally gates on
 * `ctx.evidenceGateEnabled` — when that's false/undefined, the caller must
 * not invoke this at all, which is what makes the "off" state byte-identical
 * to pre-FEAT-551 behavior (AC-2) rather than merely "admits everything."
 *
 * Reuses FEAT-542's mechanical quote-verification logic via the shared
 * `verifyEvidenceQuote` util (src/distill/evidence-verify.ts) — see AC-3 and
 * that file's own doc comment for why this must be exactly one
 * implementation, not two kept in sync by hand.
 */
import { verifyEvidenceQuote } from './evidence-verify.js';

/** Which extraction pass produced an atom — see
 *  `src/distill/prompts/extract.ts`'s `SourcedAtom`/`AtomExtractionSource`
 *  for where this tag is assigned (never part of the LLM's own JSON
 *  contract). */
export type AtomExtractionSource = 'passA' | 'passB';

/** Distinguishes the two ways a passB atom can fail this gate — never
 *  silent, always one of these two structured reasons (AC-1). */
export type EvidenceGateDropReason = 'no-evidence-field' | 'evidence-not-found';

export interface EvidenceGateCheckResult {
  admitted: boolean;
  reason: EvidenceGateDropReason | null;
}

/**
 * Decide whether one atom may reach stage-8's `insertWithCreateEvent`.
 *
 * - Pass-A atoms (or any atom with no `extractionSource` tag — e.g. a
 *   single-pass run) are ALWAYS admitted here (AC-2). Callers still gate the
 *   call itself on `evidenceGateEnabled` (see module doc comment) so the
 *   bypass is total, not just "this function happens to always say yes."
 * - A passB atom with no non-empty `evidence` field is dropped —
 *   `no-evidence-field`.
 * - A passB atom whose `evidence` field does not verify (whitespace-
 *   normalized) against `transcriptText` is dropped — `evidence-not-found`.
 *   A missing/empty `transcriptText` is treated the same as "not found" —
 *   there is nothing to verify against, so the atom cannot be trusted.
 */
export function checkEvidenceGate(
  atom: { evidence?: string | null; extractionSource?: AtomExtractionSource },
  transcriptText: string | null | undefined,
): EvidenceGateCheckResult {
  if (atom.extractionSource !== 'passB') return { admitted: true, reason: null };

  if (typeof atom.evidence !== 'string' || atom.evidence.trim().length === 0) {
    return { admitted: false, reason: 'no-evidence-field' };
  }

  if (!transcriptText || !verifyEvidenceQuote(atom.evidence, transcriptText)) {
    return { admitted: false, reason: 'evidence-not-found' };
  }

  return { admitted: true, reason: null };
}
