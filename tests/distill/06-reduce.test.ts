import { describe, it, expect } from 'vitest';
import { reduce } from '../../src/distill/stages/06-reduce.js';
import type { Atom } from '../../src/distill/prompts/extract.js';

function atom(text: string, importance = 0.5, type: Atom['type'] = 'fact'): Atom {
  return { type, text, importance, confidence: 0.8 };
}

describe('reduce stage', () => {
  it('returns all atoms when no duplicates', () => {
    const atoms = [
      atom('use sqlite-vec for vectors', 0.9),
      atom('port 7777 is the default', 0.6),
      atom('Bun is faster than Node for CLI', 0.7),
    ];
    const result = reduce(atoms);
    expect(result.length).toBe(3);
  });

  it('deduplicates atoms with identical text (case-insensitive)', () => {
    const atoms = [
      atom('use sqlite-vec for vectors', 0.5),
      atom('Use sqlite-vec for vectors', 0.8), // higher importance, different case
      atom('USE SQLITE-VEC FOR VECTORS', 0.3),
    ];
    const result = reduce(atoms);
    expect(result.length).toBe(1);
    expect(result[0].importance).toBe(0.8); // highest importance kept
  });

  it('keeps highest importance on duplicate', () => {
    const atoms = [
      atom('sqlite-vec is the vector store', 0.3),
      atom('sqlite-vec is the vector store', 0.9),
      atom('sqlite-vec is the vector store', 0.6),
    ];
    const result = reduce(atoms);
    expect(result.length).toBe(1);
    expect(result[0].importance).toBe(0.9);
  });

  it('adds contentHash to each result', () => {
    const atoms = [atom('some decision was made', 0.7)];
    const result = reduce(atoms);
    expect(typeof result[0].contentHash).toBe('string');
    expect(result[0].contentHash.length).toBe(16);
  });

  it('deduplicates by whitespace-collapsed form', () => {
    const atoms = [
      atom('use  sqlite-vec  for  vectors'), // extra spaces
      atom('use sqlite-vec for vectors'),    // normalized
    ];
    const result = reduce(atoms);
    expect(result.length).toBe(1);
  });

  it('handles empty input', () => {
    expect(reduce([])).toEqual([]);
  });

  it('treats atoms of different types but same text as same key', () => {
    // Same normalized text, different type — still a dup by content hash
    const atoms = [
      { type: 'fact' as const, text: 'sqlite-vec is used', importance: 0.5, confidence: 0.8 },
      { type: 'decision' as const, text: 'sqlite-vec is used', importance: 0.9, confidence: 0.8 },
    ];
    const result = reduce(atoms);
    expect(result.length).toBe(1);
    // Keeps the higher importance (0.9) instance — type follows it
    expect(result[0].importance).toBe(0.9);
    expect(result[0].type).toBe('decision');
  });
});
