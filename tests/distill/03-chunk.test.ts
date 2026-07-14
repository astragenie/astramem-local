import { describe, it, expect } from 'vitest';
import { chunk, resolveMaxChunkChars, DEFAULT_MAX_CHUNK_CHARS, MIN_CHUNK_CHARS, MAX_CHUNK_CHARS_CEILING } from '../../src/distill/stages/03-chunk.js';

const CHAR_LIMIT = 3200; // 800 tokens * 4 chars/token

describe('chunk stage', () => {
  it('returns at least one chunk for any non-empty input', () => {
    const chunks = chunk('user: hello\nassistant: world');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('returns empty chunk for empty input', () => {
    const chunks = chunk('');
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toBe('');
  });

  it('does not split within a single short turn', () => {
    const input = 'user: what is sqlite-vec?\nassistant: it is a vector extension for SQLite.';
    const chunks = chunk(input);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain('sqlite-vec');
    expect(chunks[0]!.text).toContain('vector extension');
  });

  it('splits at turn boundaries when content exceeds limit', () => {
    // Build a transcript with many turns that exceed 3200 chars
    const turns: string[] = [];
    for (let i = 0; i < 20; i++) {
      turns.push(`user: question number ${i} about some technical topic with sufficient detail to be long\nassistant: ${'answer '.repeat(30)} for question ${i}`);
    }
    const input = turns.join('\n\n');
    const chunks = chunk(input);
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk should be within limit (with some tolerance for large turns)
    for (const chk of chunks) {
      // Very large single turns may exceed due to unavoidable splits
      expect(chk.text.length).toBeLessThanOrEqual(CHAR_LIMIT * 2);
    }
  });

  it('assigns sequential 0-based index to chunks', () => {
    const turns: string[] = [];
    for (let i = 0; i < 15; i++) {
      turns.push(`user: question ${i}\nassistant: ${'long answer '.repeat(50)}`);
    }
    const chunks = chunk(turns.join('\n\n'));
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });

  it('each chunk contains text from the transcript', () => {
    const input = 'user: first\nassistant: response one\nuser: second\nassistant: response two';
    const chunks = chunk(input);
    const allText = chunks.map(c => c.text).join(' ');
    expect(allText).toContain('first');
    expect(allText).toContain('response two');
  });

  it('handles transcript with no role markers — single chunk', () => {
    const input = 'this is a plain paragraph\nwithout any role prefix\njust text';
    const chunks = chunk(input);
    expect(chunks.length).toBe(1);
    expect(chunks[0]!.text).toContain('paragraph');
  });

  // #273 (WS7): chunk() now accepts an explicit maxChunkChars override.
  describe('explicit maxChunkChars override', () => {
    it('defaults to DEFAULT_MAX_CHUNK_CHARS when omitted', () => {
      const turns: string[] = [];
      for (let i = 0; i < 20; i++) {
        turns.push(`user: question number ${i} about some technical topic with sufficient detail to be long\nassistant: ${'answer '.repeat(30)} for question ${i}`);
      }
      const input = turns.join('\n\n');
      expect(chunk(input)).toEqual(chunk(input, DEFAULT_MAX_CHUNK_CHARS));
    });

    it('a smaller explicit cap produces more, smaller chunks on the same input', () => {
      const turns: string[] = [];
      for (let i = 0; i < 20; i++) {
        turns.push(`user: question number ${i} about some technical topic with sufficient detail to be long\nassistant: ${'answer '.repeat(30)} for question ${i}`);
      }
      const input = turns.join('\n\n');
      const wide = chunk(input, 3200);
      const narrow = chunk(input, 800);
      expect(narrow.length).toBeGreaterThan(wide.length);
      for (const chk of narrow) {
        expect(chk.text.length).toBeLessThanOrEqual(800 * 2); // tolerance for unavoidable oversized single turns
      }
    });

    it('still respects turn boundaries at a smaller cap', () => {
      const input = 'user: what is sqlite-vec?\nassistant: it is a vector extension for SQLite.';
      const chunks = chunk(input, 800);
      expect(chunks.length).toBe(1);
      expect(chunks[0]!.text).toContain('sqlite-vec');
    });
  });

  describe('resolveMaxChunkChars', () => {
    it('falls back to the default when distill is missing', () => {
      expect(resolveMaxChunkChars({})).toBe(DEFAULT_MAX_CHUNK_CHARS);
    });

    it('falls back to the default when maxChunkChars is missing/non-numeric', () => {
      expect(resolveMaxChunkChars({ distill: {} })).toBe(DEFAULT_MAX_CHUNK_CHARS);
      expect(resolveMaxChunkChars({ distill: { maxChunkChars: NaN } })).toBe(DEFAULT_MAX_CHUNK_CHARS);
      expect(resolveMaxChunkChars({ distill: { maxChunkChars: 0 } })).toBe(DEFAULT_MAX_CHUNK_CHARS);
      expect(resolveMaxChunkChars({ distill: { maxChunkChars: -100 } })).toBe(DEFAULT_MAX_CHUNK_CHARS);
    });

    it('passes through a valid in-range value', () => {
      expect(resolveMaxChunkChars({ distill: { maxChunkChars: 1600 } })).toBe(1600);
    });

    it('clamps below MIN_CHUNK_CHARS up to the floor', () => {
      expect(resolveMaxChunkChars({ distill: { maxChunkChars: 50 } })).toBe(MIN_CHUNK_CHARS);
    });

    it('clamps above MAX_CHUNK_CHARS_CEILING down to the ceiling', () => {
      expect(resolveMaxChunkChars({ distill: { maxChunkChars: 999_999 } })).toBe(MAX_CHUNK_CHARS_CEILING);
    });

    it('truncates a non-integer value', () => {
      expect(resolveMaxChunkChars({ distill: { maxChunkChars: 1600.9 } })).toBe(1600);
    });
  });
});
