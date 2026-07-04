import { describe, it, expect } from 'vitest';
import { normalizeEntityName } from '../../src/entity/normalize.js';

// FEAT-402 AC-9 — the single normalization seam.

describe('normalizeEntityName', () => {
  it('lowercases', () => {
    expect(normalizeEntityName('Postgres')).toBe('postgres');
    expect(normalizeEntityName('TYPESCRIPT')).toBe('typescript');
  });

  it('trims leading/trailing whitespace', () => {
    expect(normalizeEntityName('  Postgres  ')).toBe('postgres');
  });

  it('collapses internal whitespace runs', () => {
    expect(normalizeEntityName('Astra   Memory')).toBe('astra memory');
  });

  it('"Postgres" / "postgres" / "  Postgres  " all normalize identically', () => {
    const a = normalizeEntityName('Postgres');
    const b = normalizeEntityName('postgres');
    const c = normalizeEntityName('  Postgres  ');
    expect(a).toBe(b);
    expect(b).toBe(c);
  });
});
