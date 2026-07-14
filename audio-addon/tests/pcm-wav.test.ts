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
});
