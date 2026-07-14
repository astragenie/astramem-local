/**
 * FEAT-491 — post-hoc speaker attribution for atom evidence.
 * FEAT-505 — fuzzy fallback (real LLMs paraphrase despite verbatim prompts).
 *
 * The distill pipeline (src/pipeline/handlers/distill.ts) hands `runPipeline`
 * a single flattened STRING (`flattenTranscriptContent`'s output), not the
 * original structured turns array — every stage 1-8 transform operates on
 * plain text. That means there is no per-turn object left by the time an
 * atom's `evidence` (a short, LLM-selected excerpt — see AtomSchema,
 * src/distill/prompts/extract.ts) reaches stage 8. Rearchitecting the whole
 * pipeline to thread structured turns end-to-end is out of scope for this
 * FEAT (see the module doc on flatten-turns.ts) — instead, speaker identity
 * is recovered deterministically from the flattened text itself, which
 * still carries a `role: [Speaker Name] text` marker per turn whenever the
 * source turn had one (flatten-turns.ts).
 *
 * This is a best-effort, line-level match — NOT full span tracking.
 *
 * Two-tier match:
 *
 *  1. EXACT SUBSTRING (pre-existing, FEAT-491): the evidence excerpt is a
 *     literal substring of a labeled line's utterance, or vice versa. Fast,
 *     unambiguous when it fires — kept as the first attempt.
 *
 *  2. FUZZY FALLBACK (FEAT-505): live-reproduced twice — the default
 *     extraction model (codex-subscription/gpt-5.4-mini) paraphrases the
 *     evidence excerpt despite the extraction prompt demanding a verbatim
 *     copy (src/distill/prompts/extract.ts), so tier 1 misses on real
 *     traffic and every atom's speaker_label came back null (L2 finding,
 *     FEAT-505). Tier 2 scores each labeled line's TOKEN CONTAINMENT against
 *     the evidence (the fraction of the shorter side's normalized token set
 *     found in the longer) and takes the best-scoring line, but only commits
 *     to it if BOTH:
 *       - the best score clears MATCH_THRESHOLD, and
 *       - the best score beats the runner-up by at least AMBIGUITY_MARGIN.
 *
 *     A bare threshold is not sufficient: a live micro-benchmark (2026-07-14,
 *     real codex-subscription output — see attribute-speaker.test.ts's doc
 *     comment for the numbers) showed that two near-duplicate lines from
 *     DIFFERENT speakers (e.g. "...the doctor WARN row..." vs "...the doctor
 *     ERROR row...") can score within 0.10 of each other, and in the worst
 *     case (the paraphrase drops the one word that distinguishes them) score
 *     an EXACT tie. Requiring a clear margin over the runner-up, not just an
 *     absolute floor, is what turns a coin-flip guess into a `null` — the
 *     misattribution guard (FEAT-505 AC-3) treats a wrong speaker as strictly
 *     worse than no speaker (consent/provenance implications), so this
 *     function is deliberately biased toward precision over recall: no
 *     match, low score, or an ambiguous near-tie all return `null`, never a
 *     guess.
 *
 *     Six real paraphrases (live codex-subscription, 2026-07-14) of
 *     transcript-style utterances scored 0.692-1.000 containment against
 *     their true source line; an unrelated line in the same transcript
 *     scored ~0.1. MATCH_THRESHOLD (0.6) sits comfortably below every real
 *     positive and comfortably above the unrelated-line noise floor.
 */

const SPEAKER_LINE_RE = /^(?:user|assistant|system|human|ai)\s*:\s*\[([^\]]+)\]\s*(.*)$/i;

/** Minimum best-candidate containment score to accept a fuzzy match at all. */
const MATCH_THRESHOLD = 0.6;

/**
 * Minimum lead the best-scoring candidate must hold over the runner-up.
 * Chosen below the real-paraphrase-with-preserved-differentiator margin
 * (0.10, live-measured) so that case still resolves, while still catching
 * the dead-tie worst case (0.00 margin, live-measured) — see the module doc
 * comment above for both numbers.
 */
const AMBIGUITY_MARGIN = 0.08;

/**
 * Evidence excerpts below this token count are not fuzzy-matched at all —
 * a short phrase ("let's", "sure thing") can spuriously clear
 * MATCH_THRESHOLD against multiple unrelated lines by chance overlap alone.
 * Exact substring matching (tier 1) still applies to short evidence; only
 * the fuzzy fallback is gated.
 */
const MIN_FUZZY_EVIDENCE_TOKENS = 4;

function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Fraction of the SHORTER token set found in the longer — tolerant of the
 *  LLM compressing/dropping a clause on one side, which a plain Dice/Jaccard
 *  coefficient penalizes twice (once per side). */
function tokenContainment(a: string, b: string): number {
  const ta = new Set(normalizeTokens(a));
  const tb = new Set(normalizeTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared / small.size;
}

interface LabeledLine {
  speaker: string;
  utterance: string;
}

function extractLabeledLines(transcriptText: string): LabeledLine[] {
  const lines: LabeledLine[] = [];
  for (const line of transcriptText.split('\n')) {
    const match = SPEAKER_LINE_RE.exec(line);
    if (!match) continue;
    const [, speaker, utterance] = match;
    if (!speaker || !utterance) continue;
    const trimmed = utterance.trim();
    if (trimmed.length === 0) continue;
    lines.push({ speaker: speaker.trim(), utterance: trimmed });
  }
  return lines;
}

/**
 * @param transcriptText the flattened transcript (flatten-turns.ts output)
 *   this atom was extracted from.
 * @param evidence the atom's own `evidence` excerpt, if any.
 * @returns the speaker label of the turn the evidence excerpt was traced
 *   back to, or `null` if there is no speaker-labeled turn it matches (or,
 *   for the fuzzy tier, if the match isn't confident enough to commit to).
 */
export function attributeSpeaker(transcriptText: string, evidence: string | null | undefined): string | null {
  if (!evidence || evidence.trim().length === 0) return null;
  const needle = evidence.trim();
  const labeledLines = extractLabeledLines(transcriptText);
  if (labeledLines.length === 0) return null;

  // Tier 1 — exact substring (FEAT-491, unchanged).
  for (const { speaker, utterance } of labeledLines) {
    if (utterance.includes(needle) || needle.includes(utterance)) {
      return speaker;
    }
  }

  // Tier 2 — fuzzy fallback (FEAT-505). See module doc comment for the
  // threshold/margin rationale.
  if (normalizeTokens(needle).length < MIN_FUZZY_EVIDENCE_TOKENS) return null;

  const scored = labeledLines
    .map(({ speaker, utterance }) => ({ speaker, score: tokenContainment(needle, utterance) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  if (best.score < MATCH_THRESHOLD) return null;

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) return null;

  return best.speaker;
}
