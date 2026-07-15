import { deflateRawSync } from 'node:zlib';

/**
 * Pure derivation of the three confidence fields FEAT-490's confidence
 * filter (astramem-local's src/audio/confidence-filter.ts) consumes, from
 * whisper.cpp CLI's actual `-ojf` (output-json-full) JSON shape. Split out
 * from whisper-cli.ts so these can be unit tested without spawning the real
 * binary (tests/segment-derive.test.ts feeds a captured real output-json-
 * full fixture through them).
 *
 * WHY these are DERIVED, not read directly off whisper.cpp: verified
 * against both whisper.cpp's public C API (include/whisper.h) and its own
 * CLI JSON writer (examples/cli/cli.cpp) during Slice B's build --
 *   - avg_logprob and compression_ratio are OpenAI-Whisper-Python /
 *     faster-whisper conventions. whisper.cpp's C API does not compute or
 *     expose either one at all -- there is no whisper_full_get_segment_*
 *     function for them. They are 100% reconstructable from data the CLI
 *     DOES expose (per-token probability, decoded text), so we reconstruct
 *     them here rather than leaving the confidence filter blind.
 *   - no_speech_prob DOES have a public getter in whisper.cpp's C API
 *     (whisper_full_get_segment_no_speech_prob), but neither the official
 *     CLI's JSON writer nor any Node binding checked during this slice's
 *     build (whisper-cpp-node, smart-whisper) surfaces it in their output.
 *     Rather than fabricate a plausible-looking float, this derives a
 *     coarse proxy from whisper.cpp's OWN visible no-speech signal: it
 *     already emits literal bracketed markers ("[BLANK_AUDIO]", "[MUSIC]",
 *     "[NOISE]" et al.) as segment TEXT when its internal no_speech_prob
 *     exceeded --no-speech-thold and suppressed real decoding -- so a
 *     segment whose only content is one of those markers really did fail
 *     whisper.cpp's own no-speech check, even though we never see the
 *     underlying float. Documented as a known accuracy gap in the add-on
 *     README, not silently passed off as the real metric.
 */

export interface WhisperCliToken {
  text: string;
  p: number;
}

export interface WhisperCliSegment {
  text: string;
  offsets: { from: number; to: number };
  tokens?: WhisperCliToken[];
}

const NON_SPEECH_MARKERS = [
  '[BLANK_AUDIO]',
  '[SILENCE]',
  '[MUSIC]',
  '[NOISE]',
  '[INAUDIBLE]',
  '(SILENCE)',
];

/**
 * True when a segment's ENTIRE text is one of whisper.cpp's own non-speech
 * display markers — i.e. this "segment" is whisper.cpp's own way of saying
 * "nothing was said here", not a real (if low-confidence) transcription.
 *
 * whisper-cli.ts uses this to drop these entirely before they become
 * AudioSegment entries at all (real finding from Slice B's E2E proof: on
 * this slice's real fixture, whisper.cpp assigns its OWN `[BLANK_AUDIO]`
 * token a HIGH probability — it is confident that "nothing was said" is the
 * right output — so avgLogprob computed from that token is NOT low, and
 * FEAT-490's confidence filter (which pairs noSpeechProb > ceiling WITH
 * avgLogprob < floor) does not reliably drop them even with
 * deriveNoSpeechProb reporting 0.95. Rather than widen that filter's
 * semantics for a proxy field it was never tuned against, the cleaner fix
 * is upstream: a display-only marker was never real transcript content, so
 * it should never reach the filter as a pseudo-segment in the first place.
 */
export function isNonSpeechMarkerOnly(text: string): boolean {
  const trimmed = text.trim().toUpperCase();
  return NON_SPEECH_MARKERS.some(marker => trimmed === marker);
}

/** Mean(ln(p)) over the segment's tokens, matching OpenAI Whisper's own
 *  avg_logprob definition. `[_BEG_]`/`[_TT_*]` control tokens are excluded
 *  -- they are not decoded speech, and their near-certain probability would
 *  bias the average toward false confidence. A segment with no usable
 *  tokens (never expected from -ojf output, but defensive) returns the
 *  filter's own low-confidence floor rather than 0 (which would read as
 *  maximally confident -- the opposite of "no data"). */
export function computeAvgLogprob(tokens: WhisperCliToken[] | undefined): number {
  const usable = (tokens ?? []).filter(t => !/^\[_[A-Z_]+_?\]$/.test(t.text.trim()) && t.p > 0);
  if (usable.length === 0) return -2.0;
  const sumLn = usable.reduce((acc, t) => acc + Math.log(t.p), 0);
  return sumLn / usable.length;
}

/** len(text) / len(deflate(text)) -- OpenAI Whisper's own hallucination
 *  heuristic: repetitive/looping "fluent junk" compresses unusually well,
 *  producing a high ratio. Empty text has no meaningful ratio; returns 1
 *  (neutral -- never trips the >2.4 threshold on its own). */
export function computeCompressionRatio(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 1;
  const raw = Buffer.byteLength(trimmed, 'utf8');
  const compressed = deflateRawSync(Buffer.from(trimmed, 'utf8')).length;
  return compressed === 0 ? 1 : raw / compressed;
}

/**
 * See module doc comment -- proxy derived from whisper.cpp's own bracketed
 * non-speech markers, not the native no_speech_prob float (no binding
 * checked in this slice exposes it).
 *
 * Deliberately delegates to isNonSpeechMarkerOnly's EXACT-match semantics
 * (fixed 2026-07-15, review 20260715T000328Z) rather than a substring
 * match. A substring match would fabricate noSpeechProb=0.95 for a segment
 * that legitimately mixes real speech with an inline marker (documented
 * real whisper.cpp behavior) -- e.g. "the meeting starts now [BLANK_AUDIO]
 * let's begin" contains real content and must not be scored as if it were
 * silence. whisper-cli.ts already drops marker-ONLY segments entirely via
 * isNonSpeechMarkerOnly before they become AudioSegment entries, so by the
 * time a segment reaches this function it has already survived that
 * filter -- this function stays exported and independently correct anyway,
 * since it is a pure function other callers may use directly on unfiltered
 * text.
 */
export function deriveNoSpeechProb(text: string): number {
  return isNonSpeechMarkerOnly(text) ? 0.95 : 0.0;
}
