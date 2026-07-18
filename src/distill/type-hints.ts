/**
 * FEAT-552 sub-scope B — deterministic type-hint rules (zero-LLM tier).
 *
 * A small, STRONG-pattern-only regex tier applied at memory-normalize time
 * (src/distill/stages/07-memory-normalize.ts) that corrects the model's atom
 * `type` when the atom's own text carries an unambiguous surface signal the
 * model missed. Measured basis (2026-07-18 deterministic-hardening
 * analysis): "X was chosen over Y" / "we decided to use X instead of Y"
 * style decisions are literally regexable, yet typeAcc measured 43-63%
 * across all models — a chunk of that gap is mechanically recoverable
 * without any additional LLM call.
 *
 * Design constraint (spec): STRONG patterns only, no hint on ambiguity.
 * `getTypeHint` fires at most one hint per atom — if more than one type's
 * pattern matches the same text, that is treated as ambiguous and no hint is
 * returned (logged, never guessed). This is verified against the full
 * 55-fixture extraction-bench gold set in tests/distill/type-hints.test.ts
 * (AC-B1): every pattern that fires must hit >=95% precision on the type it
 * claims, and no two rules ever fire on the same gold atom in that corpus.
 *
 * Each individual pattern was tuned against that same gold set to hit the
 * precision floor — see that test file's inline notes for why, e.g., the
 * decision "instead of|rather than" comparators require an imperative-verb
 * sentence opener (bare "instead of" alone false-fires on narrative
 * lesson/fact/todo text that merely mentions a comparison, not a decision).
 */

export type TypeHint = 'command' | 'decision' | 'lesson' | 'event';

export interface TypeHintMatch {
  hint: TypeHint;
  /** Stable label for the rule that fired — surfaced in census/logging, not
   *  meant to be parsed. */
  matchedPattern: string;
}

interface HintRule {
  hint: TypeHint;
  matchedPattern: string;
  test: (text: string) => boolean;
}

// ---- command: leading shell-executable token ----
// A conversational sentence that happens to START with a tool's name reads
// identically at the token level ("npm does not support X" vs "npm publish
// X") — the AUX_STOPWORDS guard below rejects the former by checking the
// SECOND token isn't a common English auxiliary/modal verb. The trailing
// `(?:\s|$)` (not `\b`) on the leading-token match additionally guards
// against a hyphenated compound word like "aws-sdk" matching bare "aws".
//
// CASE-INSENSITIVE by construction (review finding, 2026-07-18): both real
// call sites (07-memory-normalize.ts, backfill-types.ts) feed this function
// text that has ALREADY passed through normalizeText()'s ENTITY_DICT
// canonicalization — which capitalizes bare "bun" -> "Bun" and "vitest" ->
// "Vitest" (case-preserving replacement for other tokens like "npm"). A
// case-SENSITIVE lowercase-only match silently never fires for any
// bun-/vitest-led command atom in production, even though a raw-text-only
// unit test would show it firing — exactly the bug this comment now
// documents so it isn't reintroduced. Matching case-insensitively is robust
// to that (and any future) ENTITY_DICT addition, rather than hard-coupling
// this module to normalizeText()'s current rule set.
//
// 'make' deliberately excluded from this list even though it's a real CLI
// tool: it collides with "Make" in DECISION_IMPERATIVE_FIRST_RE below (a
// genuine decision atom opening "Make the feature-flag lookup default to
// false... instead of throwing" would fire BOTH command and decision once
// this match goes case-insensitive, which getTypeHint's ambiguity guard
// correctly resolves to null rather than a wrong single fire — but that
// silently drops real decision recall for a token no gold fixture in this
// corpus ever needs as a command). Not gold-tested; cut rather than risk it.
const COMMAND_TOKENS = [
  'git', 'npm', 'bun', 'npx', 'kubectl', 'curl', 'docker', 'dotnet', 'az', 'gh',
  'vitest', 'tsc', 'pg_dump', 'pg_restore', 'psql', 'aws', 'node', 'ssh', 'scp',
  'systemctl', 'journalctl', 'schtasks', 'launchctl',
] as const;
const COMMAND_LEAD_RE = new RegExp(`^(?:${COMMAND_TOKENS.join('|')})(?:\\s|$)`, 'i');
const COMMAND_AUX_STOPWORDS = new Set([
  'is', 'was', 'are', 'were', 'does', 'did', 'do', 'has', 'have', 'had',
  'will', 'would', 'should', 'could', 'can', 'not', 'no',
]);

function isCommand(text: string): boolean {
  const m = COMMAND_LEAD_RE.exec(text);
  if (!m) return false;
  const rest = text.slice(m[0].length).trim();
  const secondWord = rest.split(/\s+/)[0]?.toLowerCase();
  if (secondWord && COMMAND_AUX_STOPWORDS.has(secondWord)) return false;
  return true;
}

// ---- decision: comparative/choice language ----
// The four multi-word phrases below are unambiguous on their own. The bare
// comparators "instead of"/"rather than" are NOT — on the 55-fixture gold
// set they false-fire on narrative lesson/fact/todo prose ("tests mutated
// the same object instead of each getting a fresh copy") at ~54% precision
// standalone. Requiring the atom to OPEN with an imperative decision verb
// (the shape every genuine "Use X instead of Y" / "Cap N rather than M"
// decision atom in the gold set takes) raises that to 100% precision with
// no false fires, at the cost of not firing on decisions phrased any other
// way — acceptable per the "no hint on ambiguity" design constraint.
const DECISION_STRONG_RE = /\b(?:chosen over|in favor of|decided to (?:use|go with)|we(?:'ll| will)\s+use)\b/i;
const DECISION_COMPARATIVE_RE = /\b(?:instead of|rather than)\b/i;
const DECISION_IMPERATIVE_FIRST_RE =
  /^(?:Use|Add|Fix|Migrate|Cap|Build|Preserve|Make|Choose|Switch|Adopt|Pick|Set|Default|Prefer|Keep|Route|Store|Opt|Go with)\b/;

function isDecision(text: string): boolean {
  if (DECISION_STRONG_RE.test(text)) return true;
  return DECISION_COMPARATIVE_RE.test(text) && DECISION_IMPERATIVE_FIRST_RE.test(text);
}

// ---- lesson: retrospective/root-cause markers ----
// "lesson:" ends in punctuation, not a word character, so it cannot share a
// trailing `\b` with the other (all-word-ending) alternatives — a trailing
// `\b` right after a colon that's itself followed by whitespace is never a
// boundary (neither side is a word char), so it would silently never match.
const LESSON_RE = /\b(?:turns out|root cause|the bug was|learned that)\b|lesson:/i;

function isLesson(text: string): boolean {
  return LESSON_RE.test(text);
}

// ---- event: past-tense ship verbs ----
// Sentence-initial capitalized verb ("Shipped v0.9.0") or explicit passive
// voice ("was deployed") only — a bare mid-sentence occurrence (a parenthetical
// status annotation like "(merged)", or a verb buried in an unrelated clause
// such as "the deploy shipped" without "was"/"were" immediately before it)
// does not count. On the 55-fixture gold set this pattern never actually
// fires (real event atoms are narrated, not phrased with these verbs), but it
// also produces zero false fires — a precision floor of vacuous 100% is the
// correct, honest outcome for a STRONG-pattern-only tier, not a bug to paper
// over by loosening the match.
const EVENT_START_RE = /^(?:Shipped|Released|Deployed|Merged)\b/;
const EVENT_PASSIVE_RE = /\b(?:was|were)\s+(?:shipped|released|deployed|merged)\b/i;

function isEvent(text: string): boolean {
  return EVENT_START_RE.test(text) || EVENT_PASSIVE_RE.test(text);
}

const RULES: readonly HintRule[] = [
  { hint: 'command', matchedPattern: 'leading-shell-token', test: isCommand },
  { hint: 'decision', matchedPattern: 'decision-comparative', test: isDecision },
  { hint: 'lesson', matchedPattern: 'lesson-marker', test: isLesson },
  { hint: 'event', matchedPattern: 'ship-verb', test: isEvent },
];

/**
 * Evaluate every STRONG rule against `text` and return the single hint that
 * fired — or `null` when zero rules fired, OR when more than one fired
 * (ambiguous; logged, never guessed). Callers with a `type` to compare
 * against (07-memory-normalize.ts) treat the returned hint as an OVERRIDE
 * only when it differs from the model's own type — see that file.
 */
export function getTypeHint(
  text: string,
  opts: { log?: (message: string) => void } = {},
): TypeHintMatch | null {
  const t = text.trim();
  if (!t) return null;

  const fired = RULES.filter(rule => rule.test(t));
  if (fired.length === 0) return null;

  if (fired.length > 1) {
    const log = opts.log ?? ((message: string) => console.warn(message));
    log(
      `[type-hints] ambiguous — ${fired.map(f => f.hint).join(', ')} patterns all matched the same atom; ` +
      `no hint applied. text=${JSON.stringify(t.slice(0, 120))}`,
    );
    return null;
  }

  const [winner] = fired;
  if (!winner) return null; // unreachable (fired.length === 1 here) — satisfies noUncheckedIndexedAccess
  return { hint: winner.hint, matchedPattern: winner.matchedPattern };
}
