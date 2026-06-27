/**
 * Stage 6 — Reduce (deterministic)
 *
 * Merge atoms across chunks by hash(normalized_text).
 * When duplicates exist, keep the highest-importance instance.
 */

import { createHash } from 'node:crypto';
import type { Atom } from '../prompts/extract.js';

export interface ReducedAtom extends Atom {
  /** Hash of the normalized (lowercased, trimmed, whitespace-collapsed) text */
  contentHash: string;
}

/**
 * Merge a flat array of atoms, deduplicating by content hash.
 * On collision, keep the highest-importance instance.
 */
export function reduce(atoms: Atom[]): ReducedAtom[] {
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
