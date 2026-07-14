/**
 * Hallucination / low-confidence segment filter (FEAT-490). Single choke
 * point in the `transcribe` handler's output path (src/pipeline/handlers/
 * transcribe.ts), applied to raw ASR segments BEFORE any of them reach
 * distill — the audio-pipeline analogue of `src/distill/durability-gate.ts`,
 * one stage earlier (a junk SEGMENT filter, not a junk ATOM filter; see that
 * module's doc comment for the sibling pattern this mirrors).
 *
 * Thresholds are Vexa's (Apache-2.0) reference values verbatim — whisper.cpp
 * and faster-whisper both expose the exact fields those thresholds were
 * tuned against, so unlike a hosted cloud ASR provider (where field
 * availability varies), local can apply them as-is rather than
 * re-deriving its own. A segment is dropped when ANY of:
 *
 *   - no_speech_prob > 0.6 AND avg_logprob < -1.0   (silence/near-silence
 *     that the model still "transcribed" fluently — the classic
 *     hallucinate-on-silence failure mode)
 *   - compression_ratio > 2.4                        (repetitive/looping
 *     fluent-junk output compresses unusually well)
 *   - avg_logprob < -1.3                              (low confidence on
 *     its own, regardless of no_speech_prob)
 *
 * Order is fixed and deliberate — checked most-specific-reason-first so a
 * segment is only ever attributed to one drop reason, mirroring
 * `classifyDurability`'s single-reason-per-atom guarantee.
 */
import type { AudioSegment } from './addon-contract.js';

export type ConfidenceDropReason = 'silence_hallucination' | 'high_compression_ratio' | 'low_avg_logprob';

export interface ConfidenceThresholds {
  /** Drop when noSpeechProb exceeds this AND avgLogprob is below avgLogprobFloor. */
  noSpeechProbCeiling: number;
  /** Paired with noSpeechProbCeiling for the silence_hallucination reason. */
  avgLogprobFloorForSilence: number;
  /** Drop outright when compressionRatio exceeds this. */
  compressionRatioCeiling: number;
  /** Drop outright when avgLogprob is below this, independent of noSpeechProb. */
  avgLogprobFloor: number;
}

/** Vexa's published reference thresholds — the FEAT-490 default. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: ConfidenceThresholds = {
  noSpeechProbCeiling: 0.6,
  avgLogprobFloorForSilence: -1.0,
  compressionRatioCeiling: 2.4,
  avgLogprobFloor: -1.3,
};

export interface ConfidenceFilterResult {
  kept: AudioSegment[];
  /** One entry per reason that fired at least once, count > 0 only. */
  dropped: Array<{ reason: ConfidenceDropReason; count: number }>;
}

/** Classify a single segment; returns the drop reason or null (keep). */
export function classifySegmentConfidence(
  segment: AudioSegment,
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): ConfidenceDropReason | null {
  if (segment.noSpeechProb > thresholds.noSpeechProbCeiling && segment.avgLogprob < thresholds.avgLogprobFloorForSilence) {
    return 'silence_hallucination';
  }
  if (segment.compressionRatio > thresholds.compressionRatioCeiling) {
    return 'high_compression_ratio';
  }
  if (segment.avgLogprob < thresholds.avgLogprobFloor) {
    return 'low_avg_logprob';
  }
  return null;
}

/**
 * Filter a full segment list. Never throws; a segment list that is entirely
 * hallucinated (e.g. silence-only or music-only source audio) legitimately
 * returns `kept: []` — the caller (transcribeHandler) must treat empty
 * `kept` as "nothing to distill", not an error (FEAT-490 acceptance hint:
 * silence/music fixtures produce zero memories, not a crash).
 */
export function filterLowConfidenceSegments(
  segments: AudioSegment[],
  thresholds: ConfidenceThresholds = DEFAULT_CONFIDENCE_THRESHOLDS,
): ConfidenceFilterResult {
  const kept: AudioSegment[] = [];
  const counts = new Map<ConfidenceDropReason, number>();

  for (const segment of segments) {
    const reason = classifySegmentConfidence(segment, thresholds);
    if (reason === null) {
      kept.push(segment);
    } else {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }

  const dropped = [...counts.entries()].map(([reason, count]) => ({ reason, count }));
  return { kept, dropped };
}
