/**
 * Source-side relevance gate (FEAT-455, ADR-012 decision 2).
 *
 * Gates what gets written to the ingest spool for the hook-tap auto-capture
 * trigger, so denser sampling does not spool every turn verbatim. This is a
 * DISTINCT module from `src/distill/durability-gate.ts` per that module's own
 * AC-6 (its taxonomy is a post-distillation, formed-atom classification; this
 * gate operates on raw, pre-distillation turns and must not reuse or
 * approximate any of `ephemeral_state` / `git_derivable` / `vacuous_negative`
 * / `bare_todo` / `path_fragment`). See docs/specs/FEAT-455-spike-results.md
 * checklist #2 for the taxonomy this module implements.
 *
 * `gateRelevance` is a pure function — the caller owns the per-session dedup
 * ring buffer (a `Set<string>`, see `recordCapturedTurnHash` below) and
 * decides whether to persist it across invocations. `src/cli/capture.ts`'s
 * current wiring is a one-shot process per hook fire and does NOT persist the
 * buffer across invocations — a process restart resetting the dedup window
 * is an accepted cold-start cost (spike's own framing): dedup exists to cut
 * same-tick re-spool volume, not as a durability guarantee.
 */

import { createHash } from 'node:crypto';

export type GatedRelevanceReason = 'too_short' | 'too_large' | 'duplicate_recent' | 'structural_junk';

export interface RelevanceGateOptions {
  /** Size floor — a turn that trims to fewer characters than this is skipped
   *  (a bare "ok", "yes", emoji reaction). Byte-count floor on raw text, not
   *  a semantic judgment — independent of durability-gate's `bare_todo`. */
  minChars: number;
  /** Size cap, per turn (bytes, UTF-8) — a turn larger than this is almost
   *  certainly a giant pasted log/dump. Smaller, source-side companion to
   *  the ingest spool's own oversize quarantine (`src/ingest/spool.ts`),
   *  not a duplicate of it — that cap is on the whole envelope, this is
   *  per-turn. */
  maxBytes: number;
  /** Ring-buffer size for the dedup window — last K captured-turn hashes
   *  per session. */
  dedupWindow: number;
}

/** Structural-only junk heuristics (AC-6: no semantic/keyword taxonomy
 *  permitted here). A bare repeated-character run ("....."), a
 *  whitespace/punctuation-only turn, or a short repeated-token run
 *  ("ok ok ok"). */
const REPEATED_CHAR_RUN = /^(.)\1{4,}$/;
const REPEATED_TOKEN_RUN = /^(\S+)(\s+\1){2,}$/i;
const PUNCTUATION_OR_WHITESPACE_ONLY = /^[\p{P}\s]+$/u;

/** Normalize + SHA-256 hash a turn's text for dedup comparison. Exported so
 *  callers building the ring buffer (see `recordCapturedTurnHash`) and tests
 *  hash identically to what `gateRelevance` checks against. */
export function hashTurnText(text: string): string {
  const normalized = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Pure gate function: turn in, reason-or-null out. Mirrors
 * `classifyDurability`'s shape. Does NOT mutate `recentHashes` — the caller
 * records a kept turn's hash via `recordCapturedTurnHash` after deciding to
 * spool it.
 */
export function gateRelevance(
  turn: { role: 'user' | 'assistant'; text: string },
  recentHashes: Set<string>,
  opts: RelevanceGateOptions,
): GatedRelevanceReason | null {
  const trimmed = turn.text.trim();

  if (trimmed.length === 0) return 'structural_junk';
  if (PUNCTUATION_OR_WHITESPACE_ONLY.test(trimmed)) return 'structural_junk';
  if (REPEATED_CHAR_RUN.test(trimmed) || REPEATED_TOKEN_RUN.test(trimmed)) return 'structural_junk';

  if (trimmed.length < opts.minChars) return 'too_short';

  if (Buffer.byteLength(trimmed, 'utf8') > opts.maxBytes) return 'too_large';

  if (recentHashes.has(hashTurnText(trimmed))) return 'duplicate_recent';

  return null;
}

/**
 * Companion helper: record a kept turn's hash into the caller-owned ring
 * buffer, evicting the oldest entry once the buffer exceeds `dedupWindow`.
 * `Set` iterates in insertion order in JS, so the first key from the
 * iterator is always the oldest.
 */
export function recordCapturedTurnHash(recentHashes: Set<string>, text: string, dedupWindow: number): void {
  recentHashes.add(hashTurnText(text));
  while (recentHashes.size > dedupWindow) {
    const oldest = recentHashes.values().next().value;
    if (oldest === undefined) break;
    recentHashes.delete(oldest);
  }
}
