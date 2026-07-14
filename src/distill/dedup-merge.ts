/**
 * Dual-pass extraction merge/dedup (opt-in, `distill.extractionPasses: 2` —
 * see src/config/config.ts and src/distill/prompts/extract.ts's
 * EXTRACTION_SYSTEM_PROMPT_SPECIFICS_SWEEPER for the full motivation).
 *
 * Pass A (the existing extraction prompt) and Pass B (the "specifics
 * sweeper") run independently over the SAME chunk and are expected to
 * overlap heavily — Pass B is deliberately told duplicating Pass A is fine,
 * since asking the model to also guess what Pass A kept costs accuracy on
 * the one job Pass B actually has. This module reconciles the two atom
 * lists into one, deterministically and string-only — NO embedding call, by
 * design (keeps this cheap and free of an extra provider round-trip; a
 * semantic/embedding-based dedup is explicitly out of v1 scope).
 *
 * Rules, applied in order for every atom (Pass A atoms first, then Pass B's
 * — so a tie always favors Pass A):
 * 1. Normalize text: lowercase, strip everything but letters and digits
 *    (punctuation AND whitespace both go) — "Once or twice a year." and
 *    "once or twice a year" normalize identically.
 * 2. Exact-normalized duplicate of an already-kept atom -> drop it.
 * 3. Otherwise, if its normalized text is a (strict) substring of an
 *    already-kept atom's normalized text, OR an already-kept atom's
 *    normalized text is a substring of ITS normalized text -> duplicate.
 *    The LONGER of the two survives: if the new atom is longer, it replaces
 *    the shorter one already kept; otherwise the new atom is dropped.
 * 4. Anything left (no exact or substring relation to any kept atom) is
 *    disjoint and is kept as-is.
 */

import type { Atom } from './prompts/extract.js';

/** Lowercase, strip everything but letters/digits (Unicode-aware) — collapses
 *  case and punctuation/whitespace variants to the same key for comparison. */
export function normalizeAtomText(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export interface MergeDualPassResult {
  merged: Atom[];
  /** Count of atoms dropped as exact or substring duplicates (from either
   *  pass) — the per-chunk observability signal the pipeline logs. */
  dedupedAway: number;
}

/**
 * Merge Pass A's and Pass B's atoms for one chunk. See module doc comment
 * for the exact-duplicate / substring-duplicate / keep-longer / keep-disjoint
 * rules.
 */
export function mergeDualPassAtoms(passA: Atom[], passB: Atom[]): MergeDualPassResult {
  const kept: Array<{ atom: Atom; norm: string }> = [];
  let dedupedAway = 0;

  for (const atom of [...passA, ...passB]) {
    const norm = normalizeAtomText(atom.text);

    // An atom that normalizes to nothing (e.g. all-punctuation text, which
    // AtomSchema's min(5) already makes rare) has no meaningful comparison
    // basis — keep it rather than risk a false-positive dedup against
    // another equally-empty normalization.
    if (norm.length === 0) {
      kept.push({ atom, norm });
      continue;
    }

    let exactIdx = -1;
    let substringIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      const existing = kept[i]!;
      if (existing.norm === norm) {
        exactIdx = i;
        break;
      }
      if (existing.norm.length > 0 && (existing.norm.includes(norm) || norm.includes(existing.norm))) {
        substringIdx = i;
        break;
      }
    }

    if (exactIdx !== -1) {
      dedupedAway++;
      continue;
    }

    if (substringIdx !== -1) {
      const existing = kept[substringIdx]!;
      if (norm.length > existing.norm.length) {
        kept[substringIdx] = { atom, norm };
      }
      dedupedAway++;
      continue;
    }

    kept.push({ atom, norm });
  }

  return { merged: kept.map((k) => k.atom), dedupedAway };
}
