/**
 * FEAT-491 — post-hoc speaker attribution for atom evidence.
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
 * This is a best-effort, line-level substring match — NOT full span
 * tracking. It returns the speaker of the FIRST flattened line whose
 * utterance text contains the atom's evidence excerpt (or vice versa, for
 * an evidence excerpt slightly longer than one line, e.g. the LLM merged two
 * short caption fragments together). No match (no speaker markers present at
 * all, or the excerpt doesn't literally appear in the source) returns `null`
 * — never a guess.
 */

const SPEAKER_LINE_RE = /^(?:user|assistant|system|human|ai)\s*:\s*\[([^\]]+)\]\s*(.*)$/i;

/**
 * @param transcriptText the flattened transcript (flatten-turns.ts output)
 *   this atom was extracted from.
 * @param evidence the atom's own `evidence` excerpt, if any.
 * @returns the speaker label of the turn the evidence excerpt was traced
 *   back to, or `null` if there is no speaker-labeled turn it matches.
 */
export function attributeSpeaker(transcriptText: string, evidence: string | null | undefined): string | null {
  if (!evidence || evidence.trim().length === 0) return null;
  const needle = evidence.trim();

  for (const line of transcriptText.split('\n')) {
    const match = SPEAKER_LINE_RE.exec(line);
    if (!match) continue;
    const [, speaker, utterance] = match;
    if (!speaker || !utterance) continue;
    const haystack = utterance.trim();
    if (haystack.length === 0) continue;
    if (haystack.includes(needle) || needle.includes(haystack)) {
      return speaker.trim();
    }
  }

  return null;
}
