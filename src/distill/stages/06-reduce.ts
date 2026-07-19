/**
 * Stage 6 — Reduce (deterministic)
 *
 * Merge atoms across chunks by hash(normalized_text).
 * When duplicates exist, keep the highest-importance instance.
 */

import { createHash } from 'node:crypto';
import type { SourcedAtom } from '../prompts/extract.js';

// FEAT-551: extends SourcedAtom (Atom + optional `extractionSource`) rather
// than Atom directly. Atom is structurally assignable to SourcedAtom (the
// added field is optional), so this is additive only — every existing
// caller passing plain Atom[] is unaffected and gets `extractionSource:
// undefined` on its ReducedAtom output, which the stage-8 gate treats as
// "not passB, bypass" (AC-2).
export interface ReducedAtom extends SourcedAtom {
  /** Hash of the normalized (lowercased, trimmed, whitespace-collapsed) text */
  contentHash: string;
}

/**
 * Merge a flat array of atoms, deduplicating by content hash.
 * On collision, keep the highest-importance instance.
 */
export function reduce(atoms: SourcedAtom[]): ReducedAtom[] {
  const byHash = new Map<string, ReducedAtom>();

  for (const atom of atoms) {
    const hash = contentHash(atom.text);
    const existing = byHash.get(hash);

    if (!existing || atom.importance > existing.importance) {
      byHash.set(hash, { ...atom, contentHash: hash });
    }
  }

  return [...byHash.values()];
}

function contentHash(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  // Full 64-hex (256-bit) SHA-256 — the previous 16-hex (64-bit) slice had
  // birthday-bound collision risk around 2^32 atoms which is too low for a
  // long-running memory corpus.
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}
