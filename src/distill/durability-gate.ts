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
 * The rationale-marker check (`hasRationaleMarker`) requires the marker to
 * be in genuine causal proximity to the statement, not merely present
 * anywhere in the atom (FEAT-448, closing the FF-1 re-review gap): a
 * temporal "since" ("since 3pm"), a CLI flag's literal "--" ("--verbose"),
 * and a "because"/"reason" glued onto a contentless clause ("because
 * deploy", "because reasons") no longer count as an exemption.
 *
 * `classifyDurability` is the pure taxonomy check — always evaluates the
 * full pattern set regardless of gate mode. `gateDurability` applies the
 * `strict|lenient|off` mode on top of it:
 *   - off:     never gates (classifyDurability is not even called) — the
 *              shipped default (AC-2: byte-identical to pre-FEAT-441).
 *   - strict:  gates on any of the 5 reasons.
 *   - lenient: gates 4 of the 5 reasons (ephemeral_state, vacuous_negative,
 *              path_fragment, bare_todo). git_derivable alone is held back
 *              because a terse-but-durable decision or a rationale-bearing
 *              command referencing a commit SHA is more plausible than a
 *              terse-but-durable "is green" assertion (PM pre-mortem Q1,
 *              20260709T095000Z-pm-review-feat-441-deep-triage.md).
 *
 * RECALL-S2 (2026-07-13) moved `bare_todo` OUT of the lenient holdback and
 * into the always-gated set. Recorded decision (RECALL-S2 brief's "decide
 * deliberately" requirement): the live store's dominant junk class is
 * task-echo imperatives ("Configure X", "Approve production deployment.",
 * "$ bun run test") filed across command/todo/decision/event types alike —
 * holding bare_todo back from the *recommended* lenient mode left the
 * single biggest junk category ungated by default. A type-aware carve-out
 * for `command`-typed atoms (threading `mem.type` into `gateDurability`)
 * was considered and REJECTED: the evidence set's own "must die" examples
 * ("Rebuild", "$ bun run test") are themselves plausible `command`-typed
 * atoms, so a blanket type exemption would save exactly the junk it's
 * meant to catch. The genuine reusable command that must survive ("Run
 * tests with `bunx tsc --noEmit` for both tsconfig.json and
 * tsconfig.test.json") already does — not via its type, but because it is
 * content-rich enough to clear `BARE_TODO_MAX_WORDS` (11 words > the
 * 10-word cap) — the same content-based guard that protects every other
 * reason. `git_derivable` keeps its holdback unchanged: no counterexample
 * in the evidence set required moving it, and a terse commit reference is
 * still plausibly meaningful shorthand in a way a bare imperative rarely
 * is.
 */

export type GatedReason =
  | 'ephemeral_state'
  | 'git_derivable'
  | 'vacuous_negative'
  | 'bare_todo'
  | 'path_fragment';

export type DurabilityGateMode = 'strict' | 'lenient' | 'off';

/** Reasons gated under `lenient` mode — see module doc comment above.
 *  `git_derivable` is the only reason held back (RECALL-S2). */
const LENIENT_REASONS: ReadonlySet<GatedReason> = new Set([
  'ephemeral_state',
  'vacuous_negative',
  'path_fragment',
  'bare_todo',
]);

// ─── Pattern definitions (one home, per AC-6) ─────────────────────────────

/** Bare filesystem/transcript path with no surrounding sentence — requires
 *  at least one path separator so a single plain word ("done") never
 *  matches. Anchored to the whole (trimmed) text: a path fragment embedded
 *  inside a real sentence is not gated, only a standalone path. */
const PATH_FRAGMENT_RE =
  /^(?:[A-Za-z]:[\\/])?[\w.\-]+(?:[\\/][\w.\-]+)+(?::\d+)?$/;

/** Commit SHA referenced alongside a git-activity keyword, or a generic
 *  git-activity phrase ("N files changed", "merged into main", "N commits
 *  ahead/behind" — RECALL-S2 widened this to cover the git status-check
 *  phrasing "There are 2 commits ahead of origin/main.", which the
 *  original "branch X is/was ahead" shape didn't reach). */
const GIT_SHA_WITH_KEYWORD_RE =
  /\b(commit|sha|revision)\s*[:#]?\s*[0-9a-f]{7,40}\b/i;
const GIT_ACTIVITY_RE =
  /\b(\d+\s+files?\s+changed|files?\s+changed|merged\s+(into|branch)|pushed\s+to|branch\s+\S+\s+(is|was)\s+(ahead|behind|merged)|\d+\s+commits?\s+(ahead|behind)|commits?\s+(ahead|behind)\s+of\s+\S+)\b/i;

/** "no X identified/found/detected/present" — records an absent search
 *  result, not a proposition about the system. */
const VACUOUS_NEGATIVE_RE =
  /\bno\s+[a-z][\w\s]{0,40}?\b(identified|found|detected|present|available)\b/i;

/** "X is/are/was/were (currently )?<state adjective>" — true only at the
 *  instant written. RECALL-S2 added "ready (for review/to merge/to ship)"
 *  ("PR #485 is now ready for review.") to the adjective set — the regex
 *  is an unanchored substring test, so a trailing phrase after "ready"
 *  doesn't need its own alternative. */
const EPHEMERAL_STATE_RE =
  /\b(is|are|was|were)\s+(currently\s+)?(now\s+)?(green|red|passing|failing|running|active|in[- ]progress|ongoing|present|complete|completed|done|blocked|pending|live|stable|healthy|broken|up|down|ready)\b/i;

/** RECALL-S2: standalone operational checkpoint/status markers that don't
 *  fit the "is/are/was/were <adjective>" shape but are the same kind of
 *  transient-at-write-time scaffolding — e.g. "[CHECKPOINT] Self-verify
 *  gates pass." Folded into the ephemeral_state reason rather than a new
 *  taxonomy entry (the enum is fixed per the module doc comment). */
const EPHEMERAL_CHECKPOINT_RE =
  /^\[(?:checkpoint|check|status)\]|\bgates?\s+(pass|passed|fail|failed)\b/i;

/** Short imperative command/todo with no rationale markers. RECALL-S2
 *  widened the verb list (configure, approve, orchestrate, ensure,
 *  address, raise, set up, finalize, search, rebuild) after auditing live
 *  task-echo junk that slipped past the original 17-verb list — e.g.
 *  "Configure 'capture_source' to 'proxy'." and "Approve production
 *  deployment." (the latter filed as type `decision`, proving type alone
 *  can't distinguish junk — see module doc comment). */
const IMPERATIVE_VERB_RE =
  /^(run|fix|check|update|add|remove|delete|verify|test|build|deploy|install|restart|revert|merge|push|pull|rename|bump|ship|execute|start|stop|kill|configure|approve|orchestrate|ensure|address|raise|set\s+up|finalize|search|rebuild)\b/i;

/** RECALL-S2: a bare shell-prompt-prefixed command echo ("$ bun run
 *  test") has no leading English imperative verb for IMPERATIVE_VERB_RE
 *  to match, but is the same task-echo shape — the "$ " prompt marker
 *  itself is the tell. */
const SHELL_PROMPT_RE = /^\$\s+\S/;

const BARE_TODO_MAX_WORDS = 10;

// ─── Rationale-marker exemption (FEAT-448) ────────────────────────────────
//
// A rationale marker only exempts an atom when it is in causal proximity to
// the trigger clause — i.e. it actually binds a reason to the statement,
// not merely present somewhere in the text (FEAT-448's tightening of the
// FF-1 re-review finding). Three marker forms need disambiguation beyond
// bare keyword presence; the rest ("so that", "in order to", "to ensure",
// "rationale", an em dash) are unambiguous connectives and stay a bare
// presence check.

/** Connectives that are always genuine rationale markers wherever they
 *  appear — no further disambiguation needed. */
const UNCONDITIONAL_MARKER_RE = /\b(so that|in order to|to ensure|rationale)\b|[—–]/i;

/** "since" used as a temporal preposition ("since 3pm", "since last week",
 *  "since Monday") is not causal and must not exempt a trigger match — only
 *  "since" introducing a reason clause ("since <subject> <verb> ...") is a
 *  genuine rationale marker. */
const TEMPORAL_SINCE_RE =
  /\bsince\s+(?:\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|last\s+\w+|yesterday|today|this\s+(?:morning|afternoon|evening|week|month|year)|(?:mon|tues?|wednes?|thurs?|fri|satur?|sun)day\b|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b)/i;
const BARE_SINCE_RE = /\bsince\b/i;

/** A literal "--" counts as a dash-style rationale connective only when
 *  used as punctuation with whitespace on both sides — not when glued
 *  directly to a following identifier as a CLI flag ("--verbose"), which
 *  carries no rationale content at all. */
const PUNCTUATION_DOUBLE_DASH_RE = /(?:\s|^)--(?:\s|$)/;

/** "because"/"reason" bind a genuine cause only when at least two content
 *  words follow before the next such marker (or the end of the atom) — a
 *  bare "because deploy" or "because reasons" glues the marker on for
 *  form's sake with no actual reason attached. Checked per OCCURRENCE, not
 *  as one whole-string existential test: an atom can carry more than one
 *  because/reason marker, and a later contentless fragment ("...because
 *  bug.") must not suppress the exemption already earned by an earlier
 *  genuine one ("because deploy broke it") in the same atom (fix-round
 *  HIGH — the exemption is per-marker-occurrence, so it must hold as soon
 *  as ANY occurrence is genuine, regardless of what a different occurrence
 *  looks like). */
const BECAUSE_OR_REASON_MARKER_RE = /\b(?:because|reason)\b\s*:?\s*/gi;

function hasContentfulCausalMarker(text: string): boolean {
  const matches = [...text.matchAll(BECAUSE_OR_REASON_MARKER_RE)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const next = matches[i + 1];
    if (match === undefined || match.index === undefined) continue;
    const clauseStart = match.index + match[0].length;
    const clauseEnd = next?.index ?? text.length;
    const clauseWords = text.slice(clauseStart, clauseEnd).split(/\s+/).filter(Boolean);
    if (clauseWords.length >= 2) return true;
  }
  return false;
}

/** True when `text` carries a rationale marker in genuine causal proximity
 *  to the statement it's attached to — the single predicate both
 *  `classifyDurability` call sites use in place of a bare keyword scan. */
function hasRationaleMarker(text: string): boolean {
  if (UNCONDITIONAL_MARKER_RE.test(text)) return true;
  if (PUNCTUATION_DOUBLE_DASH_RE.test(text)) return true;
  if (BARE_SINCE_RE.test(text) && !TEMPORAL_SINCE_RE.test(text)) return true;
  if (hasContentfulCausalMarker(text)) return true;
  return false;
}

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
  if (!hasRationaleMarker(trimmed) && wordCount(trimmed) <= SHORT_ATOM_MAX_WORDS) {
    if (GIT_SHA_WITH_KEYWORD_RE.test(trimmed) || GIT_ACTIVITY_RE.test(trimmed)) return 'git_derivable';
    if (VACUOUS_NEGATIVE_RE.test(trimmed)) return 'vacuous_negative';
    if (EPHEMERAL_STATE_RE.test(trimmed) || EPHEMERAL_CHECKPOINT_RE.test(trimmed)) return 'ephemeral_state';
  }

  if ((IMPERATIVE_VERB_RE.test(trimmed) || SHELL_PROMPT_RE.test(trimmed)) && !hasRationaleMarker(trimmed)) {
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
