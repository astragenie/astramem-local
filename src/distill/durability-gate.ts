/**
 * Durability gate (FEAT-441) — single choke point for classifying
 * low-signal atom text before it is persisted at the distill store-write
 * site (`src/distill/stages/08-embed-index.ts`, immediately after the
 * ADR-006 erasure-replay filter, `memRepo.insertWithCreateEvent` call).
 *
 * AC-6: this is the ONLY module that owns the pattern-matching taxonomy —
 * no copy-pasted regex list may exist anywhere else (including the
 * `/remember` route, which bypasses this gate entirely by construction —
 * see `src/server/routes/search.ts:202` — not by re-implementing it).
 *
 * Taxonomy (fixed enum, matches FEAT-441's Requested-capability #1):
 *   - ephemeral_state:   "X is green/passing/running/present" — true only
 *                        at the instant it was written, stale the moment
 *                        CI re-runs.
 *   - git_derivable:     commit SHAs, "N files changed", branch/merge
 *                        status — already reconstructible from `git log`,
 *                        adds no signal a memory atom should carry.
 *   - vacuous_negative:  "no X identified/found" — records the absence of
 *                        a search, not a fact about the system.
 *   - bare_todo:         a short imperative command/todo with no why/how
 *                        ("Run memory test") — the *task* is ephemeral,
 *                        only the *reason* would be durable.
 *   - path_fragment:     a bare filesystem/transcript path with no
 *                        proposition attached (e.g. "src/foo.ts:84").
 *
 * `ephemeral_state`, `git_derivable`, and `vacuous_negative` only fire on a
 * SHORT atom (<= SHORT_ATOM_MAX_WORDS) with no rationale marker attached —
 * the same protection `bare_todo` always had. A long, rationale-bearing atom
 * that merely mentions a commit SHA or a status word in passing (e.g. a
 * postmortem root-cause note) persists (2026-07-09 review HIGH fix).
 *
 * `classifyDurability` is the pure taxonomy check — always evaluates the
 * full pattern set regardless of gate mode. `gateDurability` applies the
 * `strict|lenient|off` mode on top of it:
 *   - off:     never gates (classifyDurability is not even called) — the
 *              shipped default (AC-2: byte-identical to pre-FEAT-441).
 *   - strict:  gates on any of the 5 reasons.
 *   - lenient: gates only the 3 lowest-false-positive-risk reasons
 *              (ephemeral_state, vacuous_negative, path_fragment).
 *              git_derivable and bare_todo are held back from lenient
 *              because a terse-but-durable decision or a rationale-bearing
 *              command referencing a commit SHA is more plausible than a
 *              terse-but-durable "is green" assertion (PM pre-mortem Q1,
 *              20260709T095000Z-pm-review-feat-441-deep-triage.md).
 */

export type GatedReason =
  | 'ephemeral_state'
  | 'git_derivable'
  | 'vacuous_negative'
  | 'bare_todo'
  | 'path_fragment';

export type DurabilityGateMode = 'strict' | 'lenient' | 'off';

/** Reasons gated under `lenient` mode — see module doc comment above. */
const LENIENT_REASONS: ReadonlySet<GatedReason> = new Set([
  'ephemeral_state',
  'vacuous_negative',
  'path_fragment',
]);

// ─── Pattern definitions (one home, per AC-6) ─────────────────────────────

/** Bare filesystem/transcript path with no surrounding sentence — requires
 *  at least one path separator so a single plain word ("done") never
 *  matches. Anchored to the whole (trimmed) text: a path fragment embedded
 *  inside a real sentence is not gated, only a standalone path. */
const PATH_FRAGMENT_RE =
  /^(?:[A-Za-z]:[\\/])?[\w.\-]+(?:[\\/][\w.\-]+)+(?::\d+)?$/;

/** Commit SHA referenced alongside a git-activity keyword, or a generic
 *  git-activity phrase ("N files changed", "merged into main"). */
const GIT_SHA_WITH_KEYWORD_RE =
  /\b(commit|sha|revision)\s*[:#]?\s*[0-9a-f]{7,40}\b/i;
const GIT_ACTIVITY_RE =
  /\b(\d+\s+files?\s+changed|files?\s+changed|merged\s+(into|branch)|pushed\s+to|branch\s+\S+\s+(is|was)\s+(ahead|behind|merged))\b/i;

/** "no X identified/found/detected/present" — records an absent search
 *  result, not a proposition about the system. */
const VACUOUS_NEGATIVE_RE =
  /\bno\s+[a-z][\w\s]{0,40}?\b(identified|found|detected|present|available)\b/i;

/** "X is/are/was/were (currently )?<state adjective>" — true only at the
 *  instant written. */
const EPHEMERAL_STATE_RE =
  /\b(is|are|was|were)\s+(currently\s+)?(now\s+)?(green|red|passing|failing|running|active|in[- ]progress|ongoing|present|complete|completed|done|blocked|pending|live|stable|healthy|broken|up|down)\b/i;

/** Short imperative command/todo with no rationale markers. */
const IMPERATIVE_VERB_RE =
  /^(run|fix|check|update|add|remove|delete|verify|test|build|deploy|install|restart|revert|merge|push|pull|rename|bump|ship|execute|start|stop|kill)\b/i;
const RATIONALE_MARKER_RE =
  /\b(because|so that|in order to|since|to ensure|rationale|reason)\b|[—–]|--/i;
const BARE_TODO_MAX_WORDS = 8;

/**
 * Dominance/length guard shared by `ephemeral_state`, `git_derivable`, and
 * `vacuous_negative` — mirrors the protection `bare_todo` already had
 * (`RATIONALE_MARKER_RE` exemption + `BARE_TODO_MAX_WORDS` cap). Fixes a
 * 2026-07-09 review HIGH: those three patterns were unanchored substring
 * regexes with no such guard, so a rich, rationale-bearing atom that merely
 * MENTIONS a commit SHA / status word / negative-search phrase in passing
 * (e.g. a postmortem root-cause note) was misclassified as junk. Only a
 * SHORT atom (<= this word count) with NO rationale marker — i.e. one that
 * IS the ephemeral/git/negative statement, not one that happens to contain
 * it — gets gated under these three reasons now.
 */
const SHORT_ATOM_MAX_WORDS = 12;

function wordCount(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/**
 * Classify a single atom's text against the fixed 5-reason taxonomy.
 * Returns `null` when none of the low-durability patterns match (the atom
 * is durable and should persist). Order is fixed and deliberate — checked
 * most-specific-shape-first (path fragments have no whitespace at all) so
 * an atom can only ever match one reason.
 */
export function classifyDurability(text: string): GatedReason | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  if (PATH_FRAGMENT_RE.test(trimmed)) return 'path_fragment';

  // ephemeral_state / git_derivable / vacuous_negative are only trusted when
  // the candidate atom is short AND carries no rationale marker — see
  // SHORT_ATOM_MAX_WORDS doc comment above.
  if (!RATIONALE_MARKER_RE.test(trimmed) && wordCount(trimmed) <= SHORT_ATOM_MAX_WORDS) {
    if (GIT_SHA_WITH_KEYWORD_RE.test(trimmed) || GIT_ACTIVITY_RE.test(trimmed)) return 'git_derivable';
    if (VACUOUS_NEGATIVE_RE.test(trimmed)) return 'vacuous_negative';
    if (EPHEMERAL_STATE_RE.test(trimmed)) return 'ephemeral_state';
  }

  if (IMPERATIVE_VERB_RE.test(trimmed) && !RATIONALE_MARKER_RE.test(trimmed)) {
    if (wordCount(trimmed) <= BARE_TODO_MAX_WORDS) return 'bare_todo';
  }

  return null;
}

/**
 * Apply a `distill.durabilityGate` mode on top of `classifyDurability`.
 * `off` short-circuits without even running the classifier — the
 * byte-identical-to-today guarantee (AC-2) holds regardless of pattern
 * tuning, since this is the single call site every mode funnels through.
 */
export function gateDurability(text: string, mode: DurabilityGateMode): GatedReason | null {
  if (mode === 'off') return null;
  const reason = classifyDurability(text);
  if (reason === null) return null;
  if (mode === 'strict') return reason;
  return LENIENT_REASONS.has(reason) ? reason : null;
}
