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
 * Deterministic junk gate for Pass B ("specifics sweeper") atoms ONLY — Pass
 * A is never filtered. Motivation: dual-pass stacking regressed the
 * adversarial LoCoMo category (0.8085 -> 0.7660) because Pass B inflates the
 * candidate pool with generic narrative atoms Pass A already covers; the
 * frozen answerer then abstains less on unanswerable questions (binary
 * adversarial losses), and fuse.ts's min-max normalization re-ranks good
 * atoms against the junk.
 *
 * The sweeper's own prompt category list (dates, durations, quantities,
 * prices, names, quotes, one-off events) implies every legitimate Pass B
 * atom carries at least one concrete signal. An atom with none of them is
 * assumed to be generic narrative Pass A already extracted — pool
 * pollution — and is dropped before merge.
 *
 * A Pass B atom survives iff it has:
 *   (a) a non-empty entities[], OR
 *   (b) a digit in its text, OR
 *   (c) a spelled-out cardinal number, frequency word (once/twice/thrice),
 *       or duration/frequency quantifier (few/several/couple/many times,
 *       daily/weekly/monthly/...), OR
 *   (d) a quoted phrase ("..." or '...') in its text, OR
 *   (e) a month-name/weekday/absolute-date word in its text.
 *
 * (c) exists because the sweeper prompt's own worked example ("Caroline
 * said they don't go often — usually only once or twice a year.") has NO
 * entities, digit, quote, or date word — frequencies/durations are
 * routinely spoken, not written as digits ("once or twice a year", not "1
 * or 2 x/year"), and dropping them silently defeated the sweeper's own
 * headline FREQUENCY/DURATION category (review finding, 2026-07-14).
 *
 * Pure, deterministic, no LLM call — intrinsic to passes=2, no config knob
 * in v1.
 */
export interface GatePassBResult {
  kept: Atom[];
  dropped: Atom[];
}

const DIGIT_RE = /\d/;
// Matching quote pair — a lone apostrophe (e.g. "Caroline's dog") must NOT
// count, only an actual quoted phrase. For the single-apostrophe branch,
// the opening apostrophe must not be immediately preceded by a word
// character and the closing one must not be immediately followed by one —
// otherwise two unrelated possessives in the same atom ("Caroline's dog
// and Melanie's cat...") falsely read as a quoted span between them
// (review finding, 2026-07-14).
const QUOTED_PHRASE_RE = /"[^"]+"|(?<!\w)'[^']+'(?!\w)/;
// Unambiguous month names/abbreviations + weekdays — safe case-insensitive,
// none of these collide with common English words.
const DATE_WORD_RE =
  /\b(january|february|april|june|july|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
// May/March/August are also top-50-ish common English words used as a
// modal verb ("she may go"), a verb of motion ("they march forward"), or an
// adjective ("an august feel") far more often in narrative text than as a
// month. Case-insensitive matching on these three alone let exactly the
// generic-narrative junk this gate exists to block slip through (review
// finding, 2026-07-14) — require a capitalized initial as a coarse but
// effective heuristic instead.
const AMBIGUOUS_MONTH_RE = /\b(May|March|August)\b/;
// Spelled-out cardinals, frequency words, and duration/frequency
// quantifiers — see (c) above. "many" alone is too common a word to trust
// as a signal on its own, so only the compound "many times" counts.
const SPELLED_NUMBER_RE =
  /\b(once|twice|thrice|dozen|few|several|couple|many times|daily|weekly|monthly|yearly|annually|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/i;

/** Filter Pass B's atoms down to the ones carrying a concrete signal. See
 *  module doc comment above for the exact predicate. */
export function gatePassBAtoms(atoms: Atom[]): GatePassBResult {
  const kept: Atom[] = [];
  const dropped: Atom[] = [];

  for (const atom of atoms) {
    const hasEntities = Array.isArray(atom.entities) && atom.entities.length > 0;
    const hasSignal =
      hasEntities ||
      DIGIT_RE.test(atom.text) ||
      SPELLED_NUMBER_RE.test(atom.text) ||
      QUOTED_PHRASE_RE.test(atom.text) ||
      DATE_WORD_RE.test(atom.text) ||
      AMBIGUOUS_MONTH_RE.test(atom.text);

    (hasSignal ? kept : dropped).push(atom);
  }

  return { kept, dropped };
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
