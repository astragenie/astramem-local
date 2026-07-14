/**
 * Unit tests for src/segment-derive.ts against a REAL whisper.cpp CLI
 * `-ojf` (output-json-full) capture (tests/fixtures/real-whisper-cli-
 * output.json) — produced during Slice B's build by running the official
 * ggml-org/whisper.cpp CPU-only Windows binary + ggml-tiny.en against a
 * gain-boosted 30s slice of tests/fixtures/stt-bakeoff/audio/fixture-1-
 * technical-terms-solo.wav from the memory (cloud) repo, a real AMI Meeting
 * Corpus recording. Not synthetic — this is what the binary actually
 * produced. See audio-addon/README.md "Real transcription evidence" for
 * the full transcript and how it was captured.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeAvgLogprob, computeCompressionRatio, deriveNoSpeechProb, isNonSpeechMarkerOnly, type WhisperCliSegment } from '../src/segment-derive.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, 'fixtures', 'real-whisper-cli-output.json'), 'utf8'),
) as { transcription: WhisperCliSegment[] };

describe('computeAvgLogprob (real whisper.cpp token probabilities)', () => {
  it('produces a negative value (log of a probability <= 1) for every real segment', () => {
    for (const seg of fixture.transcription) {
      const avg = computeAvgLogprob(seg.tokens);
      expect(avg).toBeLessThanOrEqual(0);
      expect(Number.isFinite(avg)).toBe(true);
    }
  });

  it('excludes control tokens like [_BEG_] from the average', () => {
    const withBeg: WhisperCliSegment['tokens'] = [
      { text: '[_BEG_]', p: 0.99 },
      { text: ' hello', p: 0.5 },
    ];
    const withoutBeg: WhisperCliSegment['tokens'] = [{ text: ' hello', p: 0.5 }];
    expect(computeAvgLogprob(withBeg)).toBeCloseTo(computeAvgLogprob(withoutBeg), 10);
  });

  it('returns the low-confidence floor, not 0, when there are no usable tokens', () => {
    expect(computeAvgLogprob([])).toBeLessThan(-1);
    expect(computeAvgLogprob(undefined)).toBeLessThan(-1);
  });
});

describe('computeCompressionRatio', () => {
  it('is close to neutral (~1) for real, non-repetitive transcribed text', () => {
    for (const seg of fixture.transcription) {
      const ratio = computeCompressionRatio(seg.text);
      expect(ratio).toBeGreaterThan(0.5);
      expect(ratio).toBeLessThan(2.4); // must not trip FEAT-490's own ceiling on real prose
    }
  });

  it('is high for degenerate repetitive text (the hallucination shape it exists to catch)', () => {
    const repetitive = 'the the the the the the the the the the the the the the the the the the the the';
    expect(computeCompressionRatio(repetitive)).toBeGreaterThan(2.4);
  });

  it('returns neutral (1) for empty text rather than dividing by zero', () => {
    expect(computeCompressionRatio('')).toBe(1);
    expect(computeCompressionRatio('   ')).toBe(1);
  });
});

describe('deriveNoSpeechProb', () => {
  it('is high for whisper.cpp\'s own non-speech markers', () => {
    expect(deriveNoSpeechProb('[BLANK_AUDIO]')).toBeGreaterThan(0.6);
    expect(deriveNoSpeechProb(' [MUSIC] ')).toBeGreaterThan(0.6);
  });

  it('is low for real transcribed text from the fixture', () => {
    for (const seg of fixture.transcription) {
      expect(deriveNoSpeechProb(seg.text)).toBeLessThan(0.6);
    }
  });
});

describe('isNonSpeechMarkerOnly', () => {
  it('is true only when the ENTIRE segment text is a bare marker', () => {
    expect(isNonSpeechMarkerOnly('[BLANK_AUDIO]')).toBe(true);
    expect(isNonSpeechMarkerOnly('  [MUSIC]  ')).toBe(true);
  });

  it('is false for real transcribed text, even text mentioning a marker word inline', () => {
    for (const seg of fixture.transcription) {
      expect(isNonSpeechMarkerOnly(seg.text)).toBe(false);
    }
    expect(isNonSpeechMarkerOnly('the [BLANK_AUDIO] tag showed up in my notes')).toBe(false);
  });
});
