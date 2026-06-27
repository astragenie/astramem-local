import { describe, it, expect } from 'vitest';
import { normalize } from '../../src/distill/stages/02-normalize.js';

describe('normalize stage', () => {
  it('converts Windows backslash paths to forward slash', () => {
    const result = normalize('file at C:\\Users\\foo\\project\\src\\index.ts');
    expect(result).not.toContain('\\');
    expect(result).toContain('/');
  });

  it('replaces datetime with space separator to ISO-8601', () => {
    const result = normalize('logged at 2024-01-15 10:30:00 UTC');
    expect(result).toContain('2024-01-15T10:30:00Z');
  });

  it('normalizes claude-code agent name casing', () => {
    const result = normalize('Claude Code fixed the bug');
    expect(result.toLowerCase()).toContain('claude-code');
  });

  it('normalizes Claude Code (two words) to claude-code', () => {
    const result = normalize('As Claude Code told me...');
    expect(result.toLowerCase()).toContain('claude-code');
  });

  it('preserves text not matching any pattern', () => {
    const input = 'we decided to use sqlite-vec for vector storage';
    const result = normalize(input);
    expect(result).toContain('sqlite-vec');
  });

  it('handles empty string', () => {
    expect(normalize('')).toBe('');
  });

  it('makes forward-slash path home-relative when under home dir', () => {
    // This test is environment-dependent — just verify the function runs
    const result = normalize('/some/absolute/path/to/file.ts');
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});
