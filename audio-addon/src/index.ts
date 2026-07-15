/**
 * astramem-audio — optional whisper.cpp add-on for astramem-local's audio
 * file transcription capture (FEAT-489).
 *
 * REAL IMPLEMENTATION (Slice B). Wraps the official ggml-org/whisper.cpp
 * CLI binary (MIT, its own release CI — see src/binary-manifest.ts),
 * compiled CPU-only per docs/research/2026-07-14-audio-addon-packaging.md
 * decision 4's load-bearing GPU/VRAM constraint (FEAT-485 incident). The
 * binary is bundled into this package at publish time (see
 * scripts/fetch-binaries.mjs); the GGML model is downloaded on first use
 * into this add-on's own cache dir (src/model-cache.ts), checksum-verified
 * against src/model-manifest.ts.
 *
 * `ASTRAMEM_AUDIO_ADDON_API_VERSION` is the handshake constant astramem-local
 * checks against its own `SUPPORTED_ADDON_API_VERSIONS` — bump only on a
 * breaking change to this call contract (function signatures, expected
 * segment shape), independent of this package's own semver (packaging
 * design pass decision 2). Unchanged from Slice A — this slice ships a real
 * implementation behind the same shape, not a contract change.
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

export { ensureModel, defaultModelPath, type ConfirmDownload, type ModelFetchProgress } from './model-cache.js';
export { DEFAULT_MODEL_ID } from './model-manifest.js';
export { resolveWhisperCli, describeMissingBinary } from './binary-resolve.js';

import { existsSync } from 'node:fs';
import { defaultModelPath } from './model-cache.js';
import { runWhisperCli } from './whisper-cli.js';

/**
 * Transcribes one audio file with the bundled whisper.cpp CLI. Never
 * returns fabricated output on failure — a missing binary (unbuilt
 * platform) or missing model throws a specific, actionable Error (ADR-015
 * "no success-shaped failure" discipline, same as astramem-local's own
 * doctor checks), which the base repo's transcribeHandler already catches
 * and surfaces through its normal job-failure path (see that file's doc
 * comment). Callers that need the model auto-downloaded on first use
 * should call `ensureModel()` before `transcribe()` — this function itself
 * does not download anything, so it never blocks a job-worker call on a
 * network fetch it didn't ask for.
 */
export async function transcribe(audioPath: string, opts?: TranscribeOptions): Promise<AudioSegment[]> {
  const modelPath = opts?.modelPath ?? defaultModelPath();
  if (!existsSync(modelPath)) {
    throw new Error(
      `astramem-audio: model not found at ${modelPath} — call ensureModel() first (downloads + checksum-verifies ` +
      'on first use, design doc decision 4), or pass an explicit modelPath.',
    );
  }
  return runWhisperCli(audioPath, modelPath);
}
