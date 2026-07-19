/**
 * Mechanical (judge-free) post-judge checks — FEAT-542.
 *
 * Two independent metrics, both computed WITHOUT an LLM call and WITHOUT
 * touching judge.ts's prompt or JudgeResult schema (architect+reviewer
 * decision, FEAT-542 AC-2): a deterministic string/quote match is judge-free
 * and zero-cost, so it must not be coupled to judge non-determinism
 * (+/-7 F1 points across identical configs — FEAT-450's own triage note).
 *
 * 1. Forbidden-item detection (AC-2/AC-6): did the extractor emit a claim
 *    that must NEVER be a standing/active fact — a superseded value or the
 *    positive-polarity restatement of a negated fact.
 * 2. Evidence accuracy (AC-3): for atoms carrying a non-empty `evidence`
 *    excerpt, does that quote actually appear (whitespace-normalized) in the
 *    fixture's own source transcript.
 */
import type { JudgeAtomIn, FixtureScore } from './judge.js';
// FEAT-551: quote-verification promoted to a shared src/ util so the bench's
// own measurement and the production stage-8 admission gate
// (src/distill/evidence-gate.ts) can never drift apart — see that file's doc
// comment and src/distill/evidence-verify.ts for the full rationale.
import { verifyEvidenceQuote } from '../../../../src/distill/evidence-verify.js';

// ---------------------------------------------------------------------------
// Forbidden-item detection (AC-2, AC-6)
// ---------------------------------------------------------------------------

export interface ForbiddenItemHit {
  atomIndex: number;
  atomText: string;
  forbiddenItem: string;
}

/** Lowercase, collapse whitespace, strip light punctuation — good enough for
 *  a mechanical containment check without pulling in a full NLP dependency. */
export function normalizeClaimText(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.,!?;:'"()]/g, '');
}

/** Below this word count a `forbidden_items` entry is a bare phrase/keyword
 *  rather than a full claim (AC-6's "Friday" example) — containment alone
 *  would false-positive against any unrelated atom that happens to mention
 *  the same word as part of a different, legitimate claim. */
const BARE_PHRASE_WORD_THRESHOLD = 3;
/** For a bare phrase, require it to make up most of the atom's own text
 *  before counting it as a hit — a short forbidden phrase incidentally
 *  present inside a much longer, unrelated claim must not trigger. */
const BARE_PHRASE_DOMINANCE_RATIO = 0.6;

/**
 * Mechanical forbidden-item matcher (AC-2). Matches on the FULL normalized
 * atom text containing the full normalized forbidden-item text, not a bare
 * substring test alone (AC-6): a short forbidden phrase (fewer than
 * BARE_PHRASE_WORD_THRESHOLD words) additionally requires the phrase to
 * dominate the atom's own text, so "Friday" as a forbidden item never
 * matches a correct atom that merely mentions Friday in passing (e.g. "the
 * release after this one is still planned for next Friday's slot").
 */
export function findForbiddenItemHits(atoms: JudgeAtomIn[], forbiddenItems: string[]): ForbiddenItemHit[] {
  const hits: ForbiddenItemHit[] = [];
  for (const rawItem of forbiddenItems) {
    const normItem = normalizeClaimText(rawItem);
    if (!normItem) continue;
    const itemWordCount = normItem.split(' ').filter(Boolean).length;

    atoms.forEach((atom, atomIndex) => {
      const normAtom = normalizeClaimText(atom.text);
      if (!normAtom || !normAtom.includes(normItem)) return;
      if (itemWordCount < BARE_PHRASE_WORD_THRESHOLD) {
        const dominance = normItem.length / normAtom.length;
        if (dominance < BARE_PHRASE_DOMINANCE_RATIO) return;
      }
      hits.push({ atomIndex, atomText: atom.text, forbiddenItem: rawItem });
    });
  }
  return hits;
}

/**
 * Apply the mechanical forbidden-item penalty to an already-judged
 * FixtureScore (AC-2): any atom matching `forbidden_items` counts as a
 * precision failure independent of the LLM judge's own verdict for that
 * atom. Recomputes precision from the UNION of judge-flagged junk indices
 * and forbidden-item-hit indices, so an atom the judge already marked junk
 * is never double-counted. Returns the original `score` unchanged (no
 * allocation) when there are no hits — the overwhelming majority of
 * fixtures, which carry no `forbidden_items` at all.
 */
export function applyForbiddenItemScoring(
  score: FixtureScore,
  atoms: JudgeAtomIn[],
  forbiddenItems: string[] | undefined,
): { score: FixtureScore; hits: ForbiddenItemHit[] } {
  if (!forbiddenItems || forbiddenItems.length === 0 || atoms.length === 0) {
    return { score, hits: [] };
  }
  const hits = findForbiddenItemHits(atoms, forbiddenItems);
  if (hits.length === 0) return { score, hits };

  const judgeJunkIndices = new Set(
    score.judge.extracted_verdicts.filter(v => v.verdict === 'junk').map(v => v.index),
  );
  const forbiddenIndices = new Set(hits.map(h => h.atomIndex));
  const failIndices = new Set<number>([...judgeJunkIndices, ...forbiddenIndices]);
  const precision = (atoms.length - failIndices.size) / atoms.length;

  return { score: { ...score, precision }, hits };
}

// ---------------------------------------------------------------------------
// Evidence accuracy (AC-3)
// ---------------------------------------------------------------------------

export interface EvidenceAccuracyResult {
  /** Evidence-bearing atoms whose quote string-matched the source transcript. */
  numerator: number;
  /** Evidence-bearing atoms total. Atoms with no `evidence` field are
   *  excluded entirely (AC-3: not counted as a failure). */
  denominator: number;
}

/**
 * Computes the mechanical evidence-accuracy inputs for one fixture: of the
 * atoms that carry a non-empty `evidence` excerpt, what fraction of those
 * quotes actually appear (whitespace-normalized only — no lowercasing, no
 * punctuation stripping, since a fabricated-but-similar quote should NOT
 * count as real evidence) in the fixture's own source transcript.
 *
 * Delegates the actual quote check to `verifyEvidenceQuote`
 * (src/distill/evidence-verify.ts, FEAT-551) — the SAME function the
 * production stage-8 admission gate calls, so this measurement can never
 * silently drift from what the gate actually enforces.
 */
export function computeEvidenceAccuracy(atoms: JudgeAtomIn[], transcriptText: string): EvidenceAccuracyResult {
  let numerator = 0;
  let denominator = 0;
  for (const atom of atoms) {
    if (typeof atom.evidence !== 'string' || atom.evidence.trim().length === 0) continue;
    denominator++;
    if (verifyEvidenceQuote(atom.evidence, transcriptText)) numerator++;
  }
  return { numerator, denominator };
}

/** Builds the "source transcript" text a fixture's evidence quotes are
 *  checked against — the raw turn text, concatenated in order. Deliberately
 *  NOT the compacted/chunked pipeline text: `evidence` is documented (see
 *  src/distill/prompts/extract.ts's AtomSchema) as a verbatim quote from the
 *  conversation as a human would read it, so the raw turns are the correct
 *  ground truth to check against. */
export function fixtureTranscriptText(turns: Array<{ text: string }>): string {
  return turns.map(t => t.text).join('\n');
}
