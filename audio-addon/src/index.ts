/**
 * astramem-audio — optional whisper.cpp add-on for astramem-local's audio
 * file transcription capture (FEAT-489).
 *
 * SKELETON PACKAGE (Slice A). This module exports the shape astramem-local's
 * `probeAudioAddon` (src/audio/addon-probe.ts) checks for at runtime, and a
 * `transcribe` stub that throws rather than silently returning fabricated
 * output — the real whisper.cpp binding, model download, and prebuilt
 * per-platform binaries are Slice B (see
 * docs/research/2026-07-14-audio-addon-packaging.md decision 4, CPU-only
 * pinned per that doc's load-bearing GPU/VRAM constraint).
 *
 * `ASTRAMEM_AUDIO_ADDON_API_VERSION` is the handshake constant astramem-local
 * checks against its own `SUPPORTED_ADDON_API_VERSIONS` — bump only on a
 * breaking change to this call contract (function signatures, expected
 * segment shape), independent of this package's own semver (packaging
 * design pass decision 2).
 */

/** Must stay in lockstep with astramem-local's own copy of this constant
 *  (src/audio/addon-contract.ts) — bump both together on a breaking change. */
export const ASTRAMEM_AUDIO_ADDON_API_VERSION = 1;

export interface AudioSegment {
  text: string;
  startMs: number;
  endMs: number;
  noSpeechProb: number;
  avgLogprob: number;
  compressionRatio: number;
}

export interface TranscribeOptions {
  modelPath?: string;
}

/**
 * Skeleton stub — Slice B replaces this body with the real whisper.cpp
 * binding call. Throws (rather than returning `[]` or fabricated segments)
 * so a caller that somehow ends up with this skeleton installed in a
 * production path fails loudly, not silently — the same ADR-015 "no
 * success-shaped failure" discipline astramem-local's own doctor checks
 * follow.
 */
export async function transcribe(_audioPath: string, _opts?: TranscribeOptions): Promise<AudioSegment[]> {
  throw new Error(
    'astramem-audio is installed as a SKELETON package (Slice A) — the real whisper.cpp binding ships in Slice B. ' +
    'See docs/research/2026-07-14-audio-addon-packaging.md.',
  );
}
