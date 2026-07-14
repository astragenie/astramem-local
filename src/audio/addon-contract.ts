/**
 * Base <-> `astramem-audio` add-on contract (FEAT-489 Slice A, packaging
 * design pass `docs/research/2026-07-14-audio-addon-packaging.md` decisions
 * 1-2). This file is the base package's OWN copy of the shapes it expects
 * the add-on to export — not a shared/published package (the add-on is a
 * separate publish unit per decision 3; duplicating this small surface here
 * is cheaper than a workspace/shared-types dependency for a handful of
 * fields, and the version handshake below is exactly the mechanism that
 * catches the two copies drifting).
 *
 * Version handshake (decision 2): an integer constant, bumped only on a
 * breaking change to this call contract — NOT the add-on package's own
 * semver. `SUPPORTED_ADDON_API_VERSIONS` is the set of handshake versions
 * this build of astramem-local knows how to drive; today that is exactly
 * one version, `AUDIO_ADDON_API_VERSION`.
 */

/** The API version this copy of astramem-local speaks. */
export const AUDIO_ADDON_API_VERSION = 1;

/** Handshake versions this build accepts from an installed add-on. */
export const SUPPORTED_ADDON_API_VERSIONS: ReadonlySet<number> = new Set([AUDIO_ADDON_API_VERSION]);

/**
 * One ASR segment as whisper.cpp (and faster-whisper) natively expose it —
 * the exact fields FEAT-490's confidence filter reads. Timestamps in
 * milliseconds, matching this repo's epoch-ms convention elsewhere
 * (captured_at, etc.) rather than whisper.cpp's native seconds-float.
 */
export interface AudioSegment {
  text: string;
  startMs: number;
  endMs: number;
  /** Probability the segment contains no speech at all (0-1). */
  noSpeechProb: number;
  /** Average log-probability of the decoded tokens (negative; closer to 0
   *  is more confident). */
  avgLogprob: number;
  /** Ratio of output length to compressed output length — a whisper.cpp
   *  hallucination tell: repetitive/fluent-junk output compresses unusually
   *  well, producing a high ratio. */
  compressionRatio: number;
}

export interface TranscribeOptions {
  /** Override for the downloaded model path (config.audio.modelPath). */
  modelPath?: string;
}

/**
 * The shape the `astramem-audio` add-on's default export must satisfy.
 * `probeAudioAddon` (./addon-probe.ts) is the only place that imports the
 * add-on dynamically and checks this shape at runtime.
 */
export interface AudioAddonModule {
  /** Integer handshake version this installed add-on build speaks. */
  ASTRAMEM_AUDIO_ADDON_API_VERSION: number;
  transcribe(audioPath: string, opts?: TranscribeOptions): Promise<AudioSegment[]>;
}
