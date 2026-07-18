/**
 * FEAT-552 sub-scope C (AC-C1): command-token merge guard.
 *
 * Measured basis (2026-07-18 prod audit, FEAT-549 addendum): phi
 * false-merged `git checkout A.ts` vs `git checkout B.ts` at cosine
 * similarity 1.00 — same verb, different file argument. Cosine similarity
 * over embeddings cannot tell "same command" from "same verb, different
 * target" for short imperative command-surface atoms the way it can for
 * prose; two commands that differ only in ONE token (a filename, a flag
 * value, a path) can still embed almost identically. This module adds a
 * cheap, deterministic, LLM-free guard: for any candidate pair where EITHER
 * atom is `type: 'command'`, tokenize both atoms' text and compare the
 * resulting token SETS — a mismatch means the pair must never auto-merge,
 * no matter how high the cosine similarity or how confident a judge verdict
 * is. Wired into `src/consolidate/consolidate.ts` at the two auto-merge
 * points that bypass human review: the `>=mergeThreshold` auto-merge tier
 * and the FEAT-549 dup-judge sweep's auto-resolve step.
 *
 * Deliberately NOT shell-aware (no quoting/escaping semantics, no argument
 * parsing) — this is a guard, not a command interpreter. Token-set equality
 * (not ordered sequence equality) so `git checkout -- A.ts` and
 * `git checkout A.ts --` are still treated as equivalent — the guard exists
 * to catch a DIFFERENT command (different verb/target/flag value), not to
 * penalize incidental token reordering.
 */

/**
 * Tokenize a command-surface string for guard comparison:
 *  - split on whitespace runs
 *  - normalize path separators (backslash -> forward slash) so
 *    `C:\repo\A.ts` and `C:/repo/A.ts` compare equal
 *  - strip a single layer of surrounding quote characters (`'`, `"`, `` ` ``)
 *    from each token
 *  - drop empty tokens
 * Deliberately simple and deterministic — no shell parsing, no LLM.
 */
export function tokenizeCommandSurface(text: string): Set<string> {
  const tokens = text
    .split(/\s+/)
    .map((tok) => tok.replace(/\\/g, '/').replace(/^['"`]+|['"`]+$/g, ''))
    .filter((tok) => tok.length > 0);
  return new Set(tokens);
}

function tokenSetsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const tok of a) if (!b.has(tok)) return false;
  return true;
}

/** Stable reason string for guard-hit logging/metadata — one value, reused
 *  by every call site so a log/metadata search for it is exhaustive. */
export const COMMAND_GUARD_REASON = 'command-token-mismatch' as const;

/**
 * True when this pair must NEVER auto-merge: either atom is `type:
 * 'command'` AND their tokenized command surfaces differ. Returns `false`
 * unconditionally when NEITHER atom is `type: 'command'` (AC-C1: non-command
 * pairs are always unaffected — this is the only branch a non-command pair
 * can take).
 */
export function commandGuardBlocksMerge(
  a: { type: string; text: string },
  b: { type: string; text: string },
): boolean {
  if (a.type !== 'command' && b.type !== 'command') return false;
  return !tokenSetsEqual(tokenizeCommandSurface(a.text), tokenizeCommandSurface(b.text));
}
