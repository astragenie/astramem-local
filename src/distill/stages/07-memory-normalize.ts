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
import { getTypeHint } from '../type-hints.js';

export interface TypeHintApplied {
  from: ReducedAtom['type'];
  to: ReducedAtom['type'];
  matchedPattern: string;
}

export interface NormalizedMemory extends ReducedAtom {
  normalizedText: string;
  finalHash: string;
  /** FEAT-552 sub-scope B: set only when the deterministic type-hint tier
   *  OVERRODE the model's own `type` (i.e. a strong pattern fired AND
   *  disagreed with the model). Absent on every atom the hint left alone —
   *  either no strong pattern fired, the pattern agreed with the model, or
   *  `typeHints` is 'off'. Purely additive/observational; `type` on the
   *  returned atom already reflects the override. */
  typeHintApplied?: TypeHintApplied;
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

export interface MemoryNormalizeOptions {
  /** `distill.typeHints` config passthrough. Defaults to `'on'` — the
   *  documented shipped default (deterministic, tested, reversible). Callers
   *  with a resolved Config should pass `cfg.distill.typeHints` explicitly;
   *  omitting this option is only for call sites with no config in scope
   *  (e.g. unit tests exercising normalize in isolation), where 'on' keeps
   *  behavior consistent with production. */
  typeHints?: 'on' | 'off';
  log?: (message: string) => void;
}

/**
 * Apply memory normalization to all reduced atoms.
 * Returns atoms with `normalizedText` and `finalHash` added.
 *
 * FEAT-552 sub-scope B: when `typeHints` is 'on' (default), also runs the
 * deterministic type-hint tier (src/distill/type-hints.ts) against each
 * atom's normalized text. The hint OVERRIDES the model's `type` ONLY when it
 * fired AND disagrees with the model — a hint that agrees, or an ambiguous/
 * no-fire result, never touches `type`. This runs strictly after text
 * normalization (so patterns match the canonicalized surface, e.g. "SQLite"
 * not "sqlite") and before the hash is computed on that same normalized
 * text, so a type override never invalidates `finalHash`/dedup identity.
 */
export function memoryNormalize(
  atoms: ReducedAtom[],
  opts: MemoryNormalizeOptions = {},
): NormalizedMemory[] {
  const typeHints = opts.typeHints ?? 'on';
  return atoms.map(atom => {
    const normalizedText = normalizeText(atom.text);
    const finalHash = computeHash(normalizedText);

    if (typeHints === 'off') {
      return { ...atom, normalizedText, finalHash };
    }

    const hint = getTypeHint(normalizedText, { log: opts.log });
    if (!hint || hint.hint === atom.type) {
      return { ...atom, normalizedText, finalHash };
    }

    const typeHintApplied: TypeHintApplied = { from: atom.type, to: hint.hint, matchedPattern: hint.matchedPattern };
    return { ...atom, type: hint.hint, normalizedText, finalHash, typeHintApplied };
  });
}
