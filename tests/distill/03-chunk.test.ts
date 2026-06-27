import { describe, it, expect } from 'vitest';
import { chunk } from '../../src/distill/stages/03-chunk.js';

const CHAR_LIMIT = 3200; // 800 tokens * 4 chars/token

describe('chunk stage', () => {
  it('returns at least one chunk for any non-empty input', () => {
    const chunks = chunk('user: hello\nassistant: world');
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('returns empty chunk for empty input', () => {
    const chunks = chunk('');
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toBe('');
  });

  it('does not split within a single short turn', () => {
    const input = 'user: what is sqlite-vec?\nassistant: it is a vector extension for SQLite.';
    const chunks = chunk(input);
    expect(chunks.length).toBe(1);
    expect(chunks[0].text).toContain('sqlite-vec');
    expect(chunks[0].text).toContain('vector extension');
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
      expect(chunks[i].index).toBe(i);
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
    expect(chunks[0].text).toContain('paragraph');
  });
});
