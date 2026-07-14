/**
 * Minimal 16-bit PCM WAV read/write + peak normalization. No dependency —
 * whisper.cpp's own input reader (miniaudio) already accepts arbitrary WAV
 * files, so this module exists ONLY for the peak-normalize pre-pass below,
 * not as a general audio decoder.
 *
 * WHY peak-normalize before handing audio to whisper.cpp (real finding from
 * Slice B's own build): the AMI Meeting Corpus fixture used for this
 * slice's E2E proof (tests/fixtures/stt-bakeoff/audio/fixture-1-technical-
 * terms-solo.wav in the memory repo) is genuine recorded speech at an
 * unusually quiet level — peak amplitude ~71/32767 (~-53 dBFS) in its first
 * 15 seconds. Fed directly to whisper.cpp, EVERY segment across the full
 * 10-minute file was classified `[BLANK_AUDIO]` (whisper.cpp's own
 * no-speech heuristic, tuned against typically-normalized input, firing on
 * every window). The same audio at 40x gain (still well below clipping)
 * transcribes correctly and matches the fixture's ground truth almost
 * verbatim. Real captured audio (headset mics, system audio capture — the
 * actual FEAT-489 use case) varies far more in level than a curated eval
 * set; a cheap peak-normalize pass makes the add-on robust to that
 * variance instead of silently mistranscribing quiet input as silence.
 * Gain is capped (see MAX_GAIN) so a genuinely near-silent/noise-floor clip
 * does not get amplified into fabricated "louder" noise.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface WavPcm16Mono {
  sampleRate: number;
  samples: Int16Array;
}

/** Parses a canonical 16-bit PCM mono/stereo WAV. Stereo is downmixed to
 *  mono by averaging channels — whisper.cpp expects mono input. */
export function readWavPcm16(path: string): WavPcm16Mono {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }

  let offset = 12;
  let fmt: { channels: number; sampleRate: number; bitsPerSample: number; audioFormat: number } | null = null;
  let dataOffset = -1;
  let dataLen = 0;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: buf.readUInt16LE(offset + 8),
        channels: buf.readUInt16LE(offset + 10),
        sampleRate: buf.readUInt32LE(offset + 12),
        bitsPerSample: buf.readUInt16LE(offset + 22),
      };
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLen = size;
    }
    offset += 8 + size + (size % 2);
  }

  if (!fmt || dataOffset < 0) throw new Error(`${path}: missing fmt or data chunk`);
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16) {
    throw new Error(`${path}: only 16-bit PCM WAV is supported (got audioFormat=${fmt.audioFormat}, bitsPerSample=${fmt.bitsPerSample})`);
  }

  const frameCount = Math.floor(dataLen / (2 * fmt.channels));
  const samples = new Int16Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    if (fmt.channels === 1) {
      samples[i] = buf.readInt16LE(dataOffset + i * 2);
    } else {
      let sum = 0;
      for (let c = 0; c < fmt.channels; c++) {
        sum += buf.readInt16LE(dataOffset + (i * fmt.channels + c) * 2);
      }
      samples[i] = Math.round(sum / fmt.channels);
    }
  }

  return { sampleRate: fmt.sampleRate, samples };
}

export function writeWavPcm16Mono(path: string, wav: WavPcm16Mono): void {
  const dataLen = wav.samples.length * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(wav.sampleRate, 24);
  buf.writeUInt32LE(wav.sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < wav.samples.length; i++) {
    buf.writeInt16LE(wav.samples[i] ?? 0, 44 + i * 2);
  }
  writeFileSync(path, buf);
}

/** Cap on applied linear gain — never amplify a near-silent/noise-floor
 *  clip more than this, so normalization can't manufacture speech-shaped
 *  noise out of true silence. 64x = +36 dB. */
const MAX_GAIN = 64;
/** Target peak as a fraction of full scale (headroom against clipping). */
const TARGET_PEAK_FRACTION = 0.5;
/** Window size for per-window (not whole-file) gain: a single loud moment
 *  elsewhere in a long recording must not suppress the gain applied to a
 *  quiet stretch far away from it — see this function's doc comment for
 *  the real recording that exposed this. */
const WINDOW_SECONDS = 5;

/**
 * Peak-normalizes toward TARGET_PEAK_FRACTION of full scale, gain capped at
 * MAX_GAIN, applied PER WINDOW (not once across the whole file).
 *
 * WHY per-window, not whole-file (real finding from this slice's own E2E
 * proof): a first pass normalized by the file's single global peak. On the
 * 10-minute AMI fixture used for this slice's proof
 * (tests/fixtures/stt-bakeoff/audio/fixture-1-technical-terms-solo.wav in
 * the memory repo), one moment near 120s peaks far louder than the rest of
 * the file (a mic bump, not necessarily louder speech) — a global peak
 * normalize gains the WHOLE file by that one moment's headroom, leaving
 * every quieter stretch still too quiet for whisper.cpp's no-speech
 * heuristic and producing `[BLANK_AUDIO]` end to end. Real captured audio
 * (the actual FEAT-489 use case) can drift in level over a long session
 * for the same reason — per-window normalization tracks that drift instead
 * of being pinned by one outlier. A window with no signal above the noise
 * floor is left unchanged (see the inner peak===0 check), same reasoning
 * as the whole-file case this replaces.
 */
export function peakNormalize(wav: WavPcm16Mono): WavPcm16Mono {
  const windowSize = Math.max(1, Math.round(wav.sampleRate * WINDOW_SECONDS));
  const out = new Int16Array(wav.samples.length);
  const targetPeak = 32767 * TARGET_PEAK_FRACTION;

  for (let start = 0; start < wav.samples.length; start += windowSize) {
    const end = Math.min(wav.samples.length, start + windowSize);

    let peak = 0;
    for (let i = start; i < end; i++) peak = Math.max(peak, Math.abs(wav.samples[i] ?? 0));

    if (peak === 0) {
      for (let i = start; i < end; i++) out[i] = 0;
      continue;
    }

    const gain = Math.min(MAX_GAIN, targetPeak / peak);
    if (gain <= 1) {
      for (let i = start; i < end; i++) out[i] = wav.samples[i] ?? 0; // already loud enough; never attenuate
      continue;
    }

    for (let i = start; i < end; i++) {
      const s = (wav.samples[i] ?? 0) * gain;
      out[i] = Math.max(-32768, Math.min(32767, Math.round(s)));
    }
  }

  return { sampleRate: wav.sampleRate, samples: out };
}
