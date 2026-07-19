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

  // #271/#273 — named-speaker turn boundaries
  describe('named-speaker turn detection', () => {
    it('splits a raw named-speaker transcript (no user:/assistant: wrapper) into separate turns', () => {
      const input = [
        'Caroline: I joined an LGBTQ activist group last week!',
        "Melanie: That's awesome, tell me more.",
        "Caroline: We're organizing a pride parade downtown.",
        "Melanie: I'd love to help out if you need volunteers.",
      ].join('\n');
      const chunks = chunk(input);
      // packTurns rejoins turns under the cap with '\n\n' — a real boundary
      // shows up as a '\n\n'-joined turn count, not as a chunk count.
      const turnTexts = chunks[0]!.text.split('\n\n');
      expect(turnTexts.length).toBe(4);
      expect(turnTexts[0]).toContain('LGBTQ activist group');
      expect(turnTexts[1]).toContain("That's awesome");
    });

    it('does not split on a one-off capitalized label that never recurs', () => {
      const input = [
        'Jon: hi there',
        "Note: aside here, should merge into Jon's turn above",
        'Jon: replying to myself I guess',
      ].join('\n');
      const chunks = chunk(input);
      const turnTexts = chunks[0]!.text.split('\n\n');
      // "Note:" appears once — must NOT become its own turn. Only the
      // second "Jon:" (recurrence >= 2) is a real boundary, so there are
      // exactly 2 turns: [Jon+Note merged, Jon].
      expect(turnTexts.length).toBe(2);
      expect(turnTexts[0]).toContain('hi there');
      expect(turnTexts[0]).toContain('Note: aside here');
      expect(turnTexts[1]).toContain('replying to myself');
    });

    it('does not treat an ALL-CAPS label like "TODO:" as a named speaker', () => {
      const input = ['TODO: fix the thing', 'TODO: also fix this other thing'].join('\n');
      const chunks = chunk(input);
      // Even recurring, ALL-CAPS labels never match NAMED_SPEAKER_CANDIDATE_RE
      // (Title Case only) — stays a single turn.
      expect(chunks[0]!.text.split('\n\n').length).toBe(1);
    });

    it('is a no-op for content already wrapped in user:/assistant: (the real LoCoMo ingestion shape)', () => {
      // buildIngestEnvelope + flattenTranscriptContent always produce lines
      // like "user: Joanna: ...\nassistant: Nate: ..." — the named speaker
      // is embedded INSIDE the already-role-prefixed line, not at true line
      // start, so the named-speaker regex adds no new boundary here. This
      // is the crux finding from the #271 investigation: the fix does not
      // change chunk text for LoCoMo-shaped content.
      const input = [
        'user: Joanna: I found an awesome hiking trail in my hometown yesterday!',
        "assistant: Nate: I'm not really into hiking but I'm curious to see it.",
        'user: Joanna: Maybe I could convince you to go with me sometime!',
        "assistant: Nate: Maybe, I do like nature so that could be fun.",
      ].join('\n');
      const chunks = chunk(input);
      const turnTexts = chunks[0]!.text.split('\n\n');
      expect(turnTexts.length).toBe(4);
      // Every turn still starts with the role prefix — unchanged shape.
      expect(turnTexts.every(t => /^(user|assistant):/.test(t))).toBe(true);
    });
  });
});
