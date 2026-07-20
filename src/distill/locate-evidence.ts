/**
 * Retrieval-overhaul Phase 5 (storage half) — locate an atom's `evidence`
 * excerpt back to a concrete position in its source transcript.
 *
 * Codex architecture review: "MemoryRepo stores only an optional evidence
 * string, and recall omits it... the eval's fuzzy back-map proved only 25%
 * match, insufficient." The fix is to do the location work ONCE, at write
 * time, against the real source transcript stage 8 already has in hand
 * (`EmbedIndexContext.sourceText` — the same flattened `role: text` string
 * `attribute-speaker.ts` already matches against), rather than re-deriving a
 * lossier match later at read/eval time with no access to the original text.
 *
 * Deliberately mirrors `attribute-speaker.ts`'s two-tier match discipline
 * (exact substring first, fuzzy token-containment fallback with a margin
 * check) rather than sharing code with it — this module answers a different
 * question ("where, precisely") with a different output shape (an offset +
 * span, not a speaker label), and duplicating ~30 lines of matching logic is
 * cheaper than coupling two independent call sites to one shared internal.
 *
 * NOT full span-level word alignment: tier 1 (exact substring) gives a
 * precise span. Tier 2 (fuzzy) can only identify WHICH turn the evidence
 * most likely came from — real LLM paraphrase means there is no reliable
 * sub-line alignment to compute — so it returns the ENTIRE matched turn's
 * span, not a word-level slice within it. That is still strictly more
 * useful than the pre-existing state (no located span at all): a caller
 * building a Phase 5 evidence bundle can read the atom's own source turn
 * verbatim instead of trusting the extractor's possibly-inexact excerpt.
 */

const ROLE_LINE_RE = /^(?:user|assistant|system|human|ai)\s*:\s*(?:\[[^\]]+\]\s*)?(.*)$/i;

/** Same floor as attribute-speaker.ts's MIN_FUZZY_EVIDENCE_TOKENS — a short
 *  phrase can spuriously clear the containment threshold against multiple
 *  unrelated lines by chance overlap alone. */
const MIN_FUZZY_EVIDENCE_TOKENS = 4;

/** Same threshold/margin as attribute-speaker.ts (see that module's doc
 *  comment for the live-measured numbers this was calibrated against) —
 *  deliberately reused rather than re-derived, since both modules are
 *  matching the same real-world "LLM paraphrases a verbatim-quote
 *  instruction" failure mode against the same kind of transcript text. */
const MATCH_THRESHOLD = 0.6;
const AMBIGUITY_MARGIN = 0.08;

export interface EvidenceLocation {
  /** 0-based index of the transcript LINE (== turn, one line per turn per
   *  flatten-turns.ts) the located span falls in. */
  turnIndex: number;
  /** Half-open [charStart, charEnd) offset of the located span within the
   *  FULL transcript text passed in — not offsets relative to the line. */
  charStart: number;
  charEnd: number;
  /** The exact verbatim text found in the transcript at
   *  [charStart, charEnd) — may differ from the input `evidence` string
   *  when only the fuzzy tier matched (see module doc comment). */
  span: string;
  /** Which tier produced this location — callers that only trust precise
   *  spans (not whole-turn fuzzy matches) can filter on this. */
  matchTier: 'exact' | 'fuzzy';
}

function normalizeTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Fraction of the SHORTER token set found in the longer — see
 *  attribute-speaker.ts's identical helper for the full rationale. */
function tokenContainment(a: string, b: string): number {
  const ta = new Set(normalizeTokens(a));
  const tb = new Set(normalizeTokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const [small, big] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let shared = 0;
  for (const t of small) if (big.has(t)) shared++;
  return shared / small.size;
}

interface Line {
  index: number;
  /** Char offset of this line's FIRST character within the full transcript. */
  lineStart: number;
  /** The full raw line text (including any `role: [Speaker] ` prefix). */
  raw: string;
  /** The utterance with the role/speaker prefix stripped, when the line
   *  matches the `role: text` convention — falls back to `raw` for a plain
   *  (non-turn-prefixed) line. */
  utterance: string;
  /** Char offset of `utterance`'s first character within the full
   *  transcript (raw.length - utterance.length added to lineStart). */
  utteranceStart: number;
}

function splitLines(transcriptText: string): Line[] {
  const lines: Line[] = [];
  let offset = 0;
  let index = 0;
  for (const raw of transcriptText.split('\n')) {
    const match = ROLE_LINE_RE.exec(raw);
    const utterance = match ? match[1]! : raw;
    const utteranceStart = offset + (raw.length - utterance.length);
    lines.push({ index, lineStart: offset, raw, utterance, utteranceStart });
    offset += raw.length + 1; // +1 for the '\n' split() consumed
    index++;
  }
  return lines;
}

/**
 * Locate an atom's `evidence` excerpt within its source transcript.
 *
 * @param transcriptText the flattened transcript (flatten-turns.ts output /
 *   `EmbedIndexContext.sourceText`) this atom was extracted from.
 * @param evidence the atom's own `evidence` excerpt, if any.
 * @returns the located turn/offset/span, or `null` when there is no
 *   evidence to locate, the transcript is empty, or no turn matches
 *   confidently enough (fuzzy tier — same "no guess" posture as
 *   attribute-speaker.ts).
 */
export function locateEvidence(
  transcriptText: string,
  evidence: string | null | undefined,
): EvidenceLocation | null {
  if (!evidence || evidence.trim().length === 0) return null;
  if (!transcriptText || transcriptText.trim().length === 0) return null;
  const needle = evidence.trim();

  // Tier 1 — exact substring match against the FULL transcript. Cheapest,
  // most precise: gives a real sub-line span, not just a whole-turn match.
  const idx = transcriptText.indexOf(needle);
  if (idx !== -1) {
    const lines = splitLines(transcriptText);
    const turnIndex = lineIndexForOffset(lines, idx);
    return { turnIndex, charStart: idx, charEnd: idx + needle.length, span: needle, matchTier: 'exact' };
  }

  // Tier 2 — fuzzy fallback (real LLM paraphrase). Scores each turn's
  // UTTERANCE (role/speaker prefix stripped, so the prefix text never
  // spuriously inflates the containment score) and takes the best-scoring
  // one, only committing when it clears both the absolute threshold and the
  // margin-over-runner-up check — same discipline as attribute-speaker.ts's
  // tier 2, restated here rather than shared (see module doc comment).
  if (normalizeTokens(needle).length < MIN_FUZZY_EVIDENCE_TOKENS) return null;

  const lines = splitLines(transcriptText).filter(l => l.utterance.trim().length > 0);
  if (lines.length === 0) return null;

  const scored = lines
    .map(line => ({ line, score: tokenContainment(needle, line.utterance) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0]!;
  if (best.score < MATCH_THRESHOLD) return null;

  const runnerUp = scored[1];
  if (runnerUp && best.score - runnerUp.score < AMBIGUITY_MARGIN) return null;

  const utterance = best.line.utterance.trim();
  const trimmedStart = best.line.utteranceStart + (best.line.utterance.length - best.line.utterance.trimStart().length);
  return {
    turnIndex: best.line.index,
    charStart: trimmedStart,
    charEnd: trimmedStart + utterance.length,
    span: utterance,
    matchTier: 'fuzzy',
  };
}

function lineIndexForOffset(lines: Line[], offset: number): number {
  // Lines are in ascending lineStart order — walk from the end to find the
  // last line whose start is <= offset. Transcripts are small (a single
  // chunk's worth of turns), so a linear scan is fine; no need for a binary
  // search over what is at most a few hundred lines.
  let found = 0;
  for (const line of lines) {
    if (line.lineStart > offset) break;
    found = line.index;
  }
  return found;
}
