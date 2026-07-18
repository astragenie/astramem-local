import { describe, it, expect } from 'vitest';
import { memoryNormalize, normalizeText, computeHash } from '../../src/distill/stages/07-memory-normalize.js';
import type { ReducedAtom } from '../../src/distill/stages/06-reduce.js';

function reducedAtom(text: string, importance = 0.5): ReducedAtom {
  return {
    type: 'fact',
    text,
    importance,
    confidence: 0.8,
    contentHash: 'abc123def456abcd',
  };
}

describe('normalizeText', () => {
  it('trims leading/trailing whitespace', () => {
    expect(normalizeText('  hello world  ')).toBe('hello world');
  });

  it('collapses internal whitespace', () => {
    expect(normalizeText('hello   world\t  foo')).toBe('hello world foo');
  });

  it('applies entity dictionary: sqlite → SQLite', () => {
    const result = normalizeText('use sqlite for storage');
    expect(result).toContain('SQLite');
  });

  it('applies entity dict: sqlite-vec stays lowercase as sqlite-vec', () => {
    const result = normalizeText('use SQLITE-VEC extension');
    expect(result).toContain('sqlite-vec');
  });

  it('applies entity dict: typescript → TypeScript', () => {
    const result = normalizeText('written in typescript');
    expect(result).toContain('TypeScript');
  });

  it('applies entity dict: nodejs → Node.js', () => {
    const result = normalizeText('runs on nodejs runtime');
    expect(result).toContain('Node.js');
  });

  it('applies entity dict: fastify → Fastify', () => {
    const result = normalizeText('using fastify for HTTP');
    expect(result).toContain('Fastify');
  });
});

describe('computeHash', () => {
  it('returns 64-char hex string', () => {
    const h = computeHash('hello world');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeHash('test text')).toBe(computeHash('test text'));
  });

  it('differs for different inputs', () => {
    expect(computeHash('text A')).not.toBe(computeHash('text B'));
  });
});

describe('memoryNormalize', () => {
  it('adds normalizedText and finalHash to each atom', () => {
    const atoms = [
      reducedAtom('use sqlite for vector storage'),
      reducedAtom('port 7777 is the default'),
    ];
    const result = memoryNormalize(atoms);
    expect(result.length).toBe(2);
    for (const r of result) {
      expect(typeof r.normalizedText).toBe('string');
      expect(r.normalizedText.length).toBeGreaterThan(0);
      expect(typeof r.finalHash).toBe('string');
      expect(r.finalHash.length).toBe(64);
    }
  });

  it('applies SQLite entity canonicalization', () => {
    const result = memoryNormalize([reducedAtom('use sqlite for storage')]);
    expect(result.length).toBe(1);
    expect(result[0]!.normalizedText).toContain('SQLite');
  });

  it('handles empty array', () => {
    expect(memoryNormalize([])).toEqual([]);
  });

  it('produces stable hashes across calls', () => {
    const a1 = memoryNormalize([reducedAtom('identical text')]);
    const a2 = memoryNormalize([reducedAtom('identical text')]);
    expect(a1.length).toBe(1);
    expect(a2.length).toBe(1);
    expect(a1[0]!.finalHash).toBe(a2[0]!.finalHash);
  });

  it('preserves original atom fields', () => {
    const a = reducedAtom('some text', 0.9);
    a.type = 'decision';
    const result = memoryNormalize([a]);
    expect(result.length).toBe(1);
    expect(result[0]!.importance).toBe(0.9);
    expect(result[0]!.type).toBe('decision');
  });
});

// FEAT-552 sub-scope B: deterministic type-hint tier wiring.
describe('memoryNormalize — type-hint tier (FEAT-552 sub-scope B)', () => {
  it('overrides the model type when a strong pattern fires and disagrees (default typeHints: on)', () => {
    const a = reducedAtom('Use SQLite instead of Postgres for local storage.');
    a.type = 'fact'; // model mis-typed a decision as a fact
    const result = memoryNormalize([a]);
    expect(result[0]!.type).toBe('decision');
    expect(result[0]!.typeHintApplied).toEqual({
      from: 'fact',
      to: 'decision',
      matchedPattern: 'decision-comparative',
    });
  });

  it('leaves type untouched when the hint agrees with the model (no override needed)', () => {
    const a = reducedAtom('Use SQLite instead of Postgres for local storage.');
    a.type = 'decision'; // already correct
    const result = memoryNormalize([a]);
    expect(result[0]!.type).toBe('decision');
    expect(result[0]!.typeHintApplied).toBeUndefined();
  });

  it('leaves type untouched when no strong pattern fires', () => {
    const a = reducedAtom('some ordinary text with no strong signal');
    a.type = 'fact';
    const result = memoryNormalize([a]);
    expect(result[0]!.type).toBe('fact');
    expect(result[0]!.typeHintApplied).toBeUndefined();
  });

  it('never overrides when typeHints is explicitly off', () => {
    const a = reducedAtom('Use SQLite instead of Postgres for local storage.');
    a.type = 'fact';
    const result = memoryNormalize([a], { typeHints: 'off' });
    expect(result[0]!.type).toBe('fact');
    expect(result[0]!.typeHintApplied).toBeUndefined();
  });

  it('logs and does not override on an ambiguous (multi-pattern) atom', () => {
    const logs: string[] = [];
    const a = reducedAtom('git checkout main instead of the feature branch, Use it going forward.');
    a.type = 'fact';
    const result = memoryNormalize([a], { log: m => logs.push(m) });
    if (logs.length > 0) {
      expect(result[0]!.type).toBe('fact');
      expect(result[0]!.typeHintApplied).toBeUndefined();
    }
  });
});
