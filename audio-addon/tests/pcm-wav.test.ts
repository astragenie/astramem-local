import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { peakNormalize, readWavPcm16, writeWavPcm16Mono, type WavPcm16Mono } from '../src/pcm-wav.js';

const scratchDirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'pcm-wav-test-'));
  scratchDirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of scratchDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeWav(samples: number[], sampleRate = 16000): WavPcm16Mono {
  return { sampleRate, samples: Int16Array.from(samples) };
}

describe('readWavPcm16 / writeWavPcm16Mono round-trip', () => {
  it('preserves sample values and sample rate through a write-then-read cycle', () => {
    const dir = scratch();
    const path = join(dir, 'test.wav');
    const original = makeWav([0, 100, -100, 32767, -32768, 12345]);

    writeWavPcm16Mono(path, original);
    const readBack = readWavPcm16(path);

    expect(readBack.sampleRate).toBe(original.sampleRate);
    expect(Array.from(readBack.samples)).toEqual(Array.from(original.samples));
  });
});

describe('peakNormalize', () => {
  it('boosts a quiet real-shaped clip toward the target peak (the exact fixture-1 finding)', () => {
    // Amplitudes in the same order of magnitude as the real fixture-1
    // recording that motivated this module (peak ~71/32767 before boost).
    const quiet = makeWav([2, -3, 71, -50, 4, 10, -8]);
    const normalized = peakNormalize(quiet);

    const originalPeak = Math.max(...Array.from(quiet.samples).map(Math.abs));
    const normalizedPeak = Math.max(...Array.from(normalized.samples).map(Math.abs));
    expect(normalizedPeak).toBeGreaterThan(originalPeak);
    expect(normalizedPeak).toBeLessThanOrEqual(32767);
  });

  it('never amplifies more than the gain cap, even for a near-silent clip', () => {
    const nearSilent = makeWav([1, -1, 0, 1, -1, 0, 1]);
    const normalized = peakNormalize(nearSilent);
    // gain cap is 64x — peak of 1 could only ever reach 64 under the cap,
    // nowhere near the target peak a louder clip would reach.
    const normalizedPeak = Math.max(...Array.from(normalized.samples).map(Math.abs));
    expect(normalizedPeak).toBeLessThanOrEqual(64);
  });

  it('returns true silence unchanged rather than manufacturing a peak', () => {
    const silence = makeWav([0, 0, 0, 0, 0]);
    const normalized = peakNormalize(silence);
    expect(Array.from(normalized.samples)).toEqual([0, 0, 0, 0, 0]);
  });

  it('never attenuates audio that is already loud', () => {
    const loud = makeWav([30000, -30000, 25000]);
    const normalized = peakNormalize(loud);
    expect(Array.from(normalized.samples)).toEqual(Array.from(loud.samples));
  });

  it('documents the known window-boundary gain discontinuity (review 20260715T000328Z, not fixed here)', () => {
    // Two adjacent 5s windows at 16kHz (window size = 80,000 samples, see
    // pcm-wav.ts) with very different peaks -- the exact shape the module's
    // own doc comment describes (a loud moment "near 120s" in an otherwise
    // quiet real recording). Gain is computed independently per window with
    // no smoothing, so a quiet window right before a loud one gets a much
    // bigger gain than the loud window itself -- a real, KNOWN step at the
    // boundary, not (yet) crossfaded. This test pins that behavior down so
    // a future smoothing fix shows up as an intentional test change, not a
    // silent regression either way.
    const sampleRate = 16000;
    const windowSamples = sampleRate * 5;
    const quietWindow = new Array(windowSamples).fill(0).map((_, i) => (i % 100 === 0 ? 20 : 2));
    const loudWindow = new Array(windowSamples).fill(0).map((_, i) => (i % 100 === 0 ? 16000 : 100));
    const wav = makeWav([...quietWindow, ...loudWindow], sampleRate);

    const normalized = peakNormalize(wav);

    // Gain actually applied to a representative sample in each window,
    // inferred from before/after ratio at that sample.
    const gainAt = (idx: number) => {
      const before = wav.samples[idx] ?? 0;
      const after = normalized.samples[idx] ?? 0;
      return before === 0 ? 0 : after / before;
    };
    const gainInQuietWindow = gainAt(0); // peak sample of the quiet window
    const gainInLoudWindow = gainAt(windowSamples); // peak sample of the loud window

    // The quiet window's peak (20) is amplified far more than the loud
    // window's peak (16000) -- confirming the two windows do NOT share one
    // gain, i.e. a step exists at the boundary.
    expect(gainInQuietWindow).toBeGreaterThan(gainInLoudWindow * 10);
    // Both windows individually still respect the target-peak/no-clip
    // contract on their own terms.
    expect(Math.abs(normalized.samples[0] ?? 0)).toBeLessThanOrEqual(32767);
    expect(Math.abs(normalized.samples[windowSamples] ?? 0)).toBeLessThanOrEqual(32767);
  });
});
