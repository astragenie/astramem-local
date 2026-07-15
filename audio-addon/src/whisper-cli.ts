import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AudioSegment } from './index.js';
import { peakNormalize, readWavPcm16, writeWavPcm16Mono } from './pcm-wav.js';
import { computeAvgLogprob, computeCompressionRatio, deriveNoSpeechProb, isNonSpeechMarkerOnly, type WhisperCliSegment } from './segment-derive.js';
import { describeMissingBinary, resolveWhisperCli } from './binary-resolve.js';

const execFileAsync = promisify(execFile);

interface WhisperCliJsonOutput {
  transcription: WhisperCliSegment[];
}

/**
 * Runs the bundled whisper.cpp CLI against one audio file and returns
 * AudioSegment[] per astramem-local's addon-contract.ts shape. This is the
 * ONLY function in the add-on that touches the filesystem/spawns a process
 * — everything else in this package is pure/testable without a real
 * binary or model installed.
 *
 * Pipeline: peak-normalize (pcm-wav.ts, see its doc comment for why) ->
 * write to a scratch temp dir -> spawn `whisper-cli -m <model> -f <wav>
 * -ojf -of <prefix> -ng` (-ng = --no-gpu, belt-and-suspenders on top of the
 * binary already being compiled CPU-only, design doc decision 4) -> parse
 * the -ojf (output-json-full) JSON, which is the only whisper.cpp output
 * mode exposing per-token probabilities -> derive avgLogprob/
 * compressionRatio/noSpeechProb (segment-derive.ts) -> clean up the temp
 * dir unconditionally (try/finally).
 */
export async function runWhisperCli(audioPath: string, modelPath: string): Promise<AudioSegment[]> {
  const resolved = resolveWhisperCli();
  if (!resolved) {
    throw new Error(describeMissingBinary());
  }

  const scratchDir = mkdtempSync(join(tmpdir(), 'astramem-audio-'));
  try {
    const wav = peakNormalize(readWavPcm16(audioPath));
    const normalizedPath = join(scratchDir, 'input.wav');
    writeWavPcm16Mono(normalizedPath, wav);

    const outPrefix = join(scratchDir, 'out');
    await execFileAsync(resolved.cliPath, [
      '-m', modelPath,
      '-f', normalizedPath,
      '-ojf',
      '-of', outPrefix,
      '-ng', // --no-gpu: never invoke a GPU backend, even if one happened to be compiled in.
      '-l', 'en',
    ], { maxBuffer: 64 * 1024 * 1024 });

    const jsonPath = `${outPrefix}.json`;
    const raw = readFileSync(jsonPath, 'utf8');
    const parsed = JSON.parse(raw) as WhisperCliJsonOutput;

    // Drop whisper.cpp's own non-speech display markers (`[BLANK_AUDIO]` et
    // al.) entirely — see isNonSpeechMarkerOnly's doc comment for why these
    // must never reach FEAT-490's confidence filter as pseudo-segments.
    return parsed.transcription
      .filter(seg => !isNonSpeechMarkerOnly(seg.text))
      .map((seg): AudioSegment => ({
        text: seg.text.trim(),
        startMs: seg.offsets.from,
        endMs: seg.offsets.to,
        noSpeechProb: deriveNoSpeechProb(seg.text),
        avgLogprob: computeAvgLogprob(seg.tokens),
        compressionRatio: computeCompressionRatio(seg.text),
      }));
  } catch (err) {
    if (err instanceof Error && 'stderr' in err) {
      const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
      throw new Error(`whisper-cli failed for ${audioPath}: ${err.message}${stderr ? `\n${stderr}` : ''}`);
    }
    throw err;
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
}
