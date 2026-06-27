/**
 * Stage 7 — Memory-normalize (deterministic)
 *
 * Apply canonical text rules to each reduced atom:
 * - Trim and collapse whitespace
 * - Apply entity dictionary (case canonicalization)
 * - Compute final SHA-256 hash of the normalized text
 */

import { createHash } from 'node:crypto';
import type { ReducedAtom } from './06-reduce.js';

export interface NormalizedMemory extends ReducedAtom {
  normalizedText: string;
  finalHash: string;
}

/**
 * Entity dictionary: patterns → canonical replacement.
 * Applied as case-insensitive whole-word replacements.
 * Extend here as more entities are discovered.
 */
const ENTITY_DICT: Array<[pattern: RegExp, canonical: string]> = [
  // sqlite-vec MUST precede bare sqlite so hyphenated form is protected first
  [/\bsqlite-vec\b/gi, 'sqlite-vec'],
  [/\bsqlite\b(?!-vec)/gi, 'SQLite'],
  [/\bpostgres(?:ql)?\b/gi, 'PostgreSQL'],
  [/\bmysql\b/gi, 'MySQL'],
  [/\bjavascript\b/gi, 'JavaScript'],
  [/\btypescript\b/gi, 'TypeScript'],
  [/\bnodejs\b|\bnode\.js\b/gi, 'Node.js'],
  [/\bnpm\b/g, 'npm'],
  [/\bbun\b/gi, 'Bun'],
  [/\bfastify\b/gi, 'Fastify'],
  [/\bzod\b/gi, 'Zod'],
  [/\bvitest\b/gi, 'Vitest'],
  [/\bgithub\b/gi, 'GitHub'],
  [/\bwindows\b/gi, 'Windows'],
  [/\bmacos\b|mac os x\b/gi, 'macOS'],
  [/\blinux\b/gi, 'Linux'],
];

/**
 * Normalize a single atom text to canonical form.
 */
export function normalizeText(text: string): string {
  let t = text.trim();

  // Collapse internal whitespace runs to single space
  t = t.replace(/\s+/g, ' ');

  // Apply entity dictionary
  for (const [pattern, canonical] of ENTITY_DICT) {
    t = t.replace(pattern, canonical);
  }

  return t;
}

/**
 * Compute a stable hash for a normalized memory text.
 * This is the dedup key used when inserting into the memories table.
 */
export function computeHash(normalizedText: string): string {
  return createHash('sha256').update(normalizedText, 'utf8').digest('hex');
}

/**
 * Apply memory normalization to all reduced atoms.
 * Returns atoms with `normalizedText` and `finalHash` added.
 */
export function memoryNormalize(atoms: ReducedAtom[]): NormalizedMemory[] {
  return atoms.map(atom => {
    const normalizedText = normalizeText(atom.text);
    const finalHash = computeHash(normalizedText);
    return { ...atom, normalizedText, finalHash };
  });
}
