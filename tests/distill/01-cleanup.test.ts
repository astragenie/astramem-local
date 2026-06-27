import { describe, it, expect } from 'vitest';
import { cleanup } from '../../src/distill/stages/01-cleanup.js';

describe('cleanup stage', () => {
  it('normalizes CRLF to LF', () => {
    const result = cleanup('line1\r\nline2\r\n');
    expect(result).not.toContain('\r');
    expect(result).toContain('line1\nline2');
  });

  it('strips trailing whitespace from each line', () => {
    const result = cleanup('hello   \nworld  \n');
    expect(result).toBe('hello\nworld');
  });

  it('collapses 3+ consecutive blank lines to 2', () => {
    const result = cleanup('a\n\n\n\n\nb');
    // After collapsing, max 2 blank lines (2 newlines = 1 blank line separator)
    expect(result).not.toMatch(/\n{3,}/);
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('deduplicates 3+ consecutive identical lines', () => {
    const repeated = 'DEBUG: tool output\n'.repeat(5);
    const result = cleanup(repeated);
    // Only 1 instance should remain
    const lines = result.split('\n').filter(l => l.includes('DEBUG: tool output'));
    expect(lines.length).toBe(1);
  });

  it('preserves non-repeated lines', () => {
    const input = 'line1\nline2\nline3';
    const result = cleanup(input);
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
  });

  it('handles empty string', () => {
    expect(cleanup('')).toBe('');
  });

  it('handles single line', () => {
    expect(cleanup('hello world')).toBe('hello world');
  });

  it('allows 2 consecutive identical lines (under threshold)', () => {
    const input = 'same line\nsame line\ndifferent';
    const result = cleanup(input);
    const count = result.split('\n').filter(l => l === 'same line').length;
    expect(count).toBe(2);
  });
});
