/**
 * tests/audio/confidence-filter.test.ts — FEAT-490.
 *
 * Reference thresholds are Vexa's (Apache-2.0) verbatim values. A segment is
 * dropped when: (noSpeechProb > 0.6 AND avgLogprob < -1.0), OR
 * compressionRatio > 2.4, OR avgLogprob < -1.3.
 */
import { describe, it, expect } from 'vitest';
import {
  classifySegmentConfidence,
  filterLowConfidenceSegments,
  DEFAULT_CONFIDENCE_THRESHOLDS,
} from '../../src/audio/confidence-filter.js';
import type { AudioSegment } from '../../src/audio/addon-contract.js';

function seg(overrides: Partial<AudioSegment>): AudioSegment {
  return {
    text: 'hello world',
    startMs: 0,
    endMs: 1000,
    noSpeechProb: 0.05,
    avgLogprob: -0.2,
    compressionRatio: 1.1,
    ...overrides,
  };
}

describe('classifySegmentConfidence', () => {
  it('keeps a clean, high-confidence segment', () => {
    expect(classifySegmentConfidence(seg({}))).toBeNull();
  });

  it('drops silence-hallucination: noSpeechProb > 0.6 AND avgLogprob < -1.0', () => {
    expect(classifySegmentConfidence(seg({ noSpeechProb: 0.9, avgLogprob: -1.5 }))).toBe('silence_hallucination');
  });

  it('does NOT drop on noSpeechProb alone without a low avgLogprob', () => {
    expect(classifySegmentConfidence(seg({ noSpeechProb: 0.9, avgLogprob: -0.1 }))).toBeNull();
  });

  it('drops high_compression_ratio outright (> 2.4)', () => {
    expect(classifySegmentConfidence(seg({ compressionRatio: 2.5 }))).toBe('high_compression_ratio');
  });

  it('keeps compressionRatio exactly at the 2.4 boundary', () => {
    expect(classifySegmentConfidence(seg({ compressionRatio: 2.4 }))).toBeNull();
  });

  it('drops low_avg_logprob outright (< -1.3), independent of noSpeechProb', () => {
    expect(classifySegmentConfidence(seg({ avgLogprob: -1.4, noSpeechProb: 0.01 }))).toBe('low_avg_logprob');
  });

  it('respects custom thresholds', () => {
    const strict = { ...DEFAULT_CONFIDENCE_THRESHOLDS, avgLogprobFloor: -0.05 };
    expect(classifySegmentConfidence(seg({ avgLogprob: -0.1 }), strict)).toBe('low_avg_logprob');
  });
});

describe('filterLowConfidenceSegments', () => {
  it('keeps everything and reports no drops when all segments are clean', () => {
    const { kept, dropped } = filterLowConfidenceSegments([seg({}), seg({ text: 'second' })]);
    expect(kept).toHaveLength(2);
    expect(dropped).toEqual([]);
  });

  it('silence-only fixture: every segment hallucinated -> kept: [] (not an error)', () => {
    const silenceFixture: AudioSegment[] = Array.from({ length: 5 }, () =>
      seg({ noSpeechProb: 0.95, avgLogprob: -2.0, text: 'you' }),
    );
    const { kept, dropped } = filterLowConfidenceSegments(silenceFixture);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([{ reason: 'silence_hallucination', count: 5 }]);
  });

  it('music-only fixture (high compression ratio, repetitive fluent junk): kept: []', () => {
    const musicFixture: AudioSegment[] = Array.from({ length: 3 }, () =>
      seg({ compressionRatio: 3.0, text: 'la la la la la la' }),
    );
    const { kept, dropped } = filterLowConfidenceSegments(musicFixture);
    expect(kept).toEqual([]);
    expect(dropped).toEqual([{ reason: 'high_compression_ratio', count: 3 }]);
  });

  it('mixed batch: counts each reason separately, only one reason per segment', () => {
    const segments = [
      seg({ text: 'good one' }),
      seg({ noSpeechProb: 0.9, avgLogprob: -1.5, text: 'silence' }),
      seg({ compressionRatio: 3.0, text: 'loop' }),
      seg({ avgLogprob: -1.4, text: 'mumble' }),
    ];
    const { kept, dropped } = filterLowConfidenceSegments(segments);
    expect(kept).toHaveLength(1);
    expect(kept[0]?.text).toBe('good one');
    expect(dropped.sort((a, b) => a.reason.localeCompare(b.reason))).toEqual([
      { reason: 'high_compression_ratio', count: 1 },
      { reason: 'low_avg_logprob', count: 1 },
      { reason: 'silence_hallucination', count: 1 },
    ]);
  });
});
