/**
 * Shannon-entropy secret detector (stage-0 redaction, SEC-3/5).
 *
 * Runs LAST, over whatever text survives the pattern-detector pass — catches
 * high-randomness tokens (raw keys, unlabeled secrets) that don't match a
 * known vendor format. False-positive guards keep it from flagging git SHAs,
 * UUIDs, and file paths (see redactText doc-comment for the full list).
 */

import { ANY_QUOTE_CHAR } from './detectors.js';

// Floor applies ONLY to unlabeled tokens (FEAT-459 decision point). Labeled
// short secrets (e.g. `token=<12-char-fragment>`) never reach this floor at
// all — the generic_credential pattern detector (detectors.ts) runs BEFORE
// this stage, matches on the label alone, and has no minimum length on its
// captured value, so a labeled match is redacted at any length. Lowering
// this floor for "label context" here would be redundant AND would remove
// the one false-positive guard protecting genuinely unlabeled short tokens
// (a stray 12-char identifier, a short hash fragment, etc.) from being
// flagged on entropy alone — so the floor stays fixed regardless of nearby
// text, by design.
const MIN_TOKEN_LENGTH = 20;
const CONTEXT_WINDOW = 40;
const HEX_DIGEST_CONTEXT_RE = /\b(commit|sha|hash|digest)\b/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_HEX_RE = /^[0-9a-f]+$/i;
const PLACEHOLDER_RE = /^\[REDACTED:[^\]]+\]$/;

// FEAT-459 review fix: a `LABEL=VALUE` pair with no surrounding whitespace
// (e.g. `PASSWORD_MIN_LENGTH=8`) tokenizes as ONE opaque unit here — this
// detector has no concept of "label" vs. "value", unlike the pattern
// detectors in detectors.ts. A long, character-diverse identifier glued to
// a trivial numeric/boolean value can clear the entropy threshold on the
// LABEL's diversity alone even though the value itself carries no secret
// (measured: `PASSWORD_MIN_LENGTH=8` scores >4.0 bits/char purely from its
// 18 distinct label characters). Mirrors the same numeric/boolean value
// guard detectors.ts applies to its any-segment compound-label match.
const CONFIG_ASSIGNMENT_RE = /^[A-Za-z][A-Za-z0-9_]*[:=](?:\d+|true|false)$/i;

// FEAT-463: a quoted/JSON label followed by a SPACE before its value (e.g.
// `"PASSWORD_MIN_LENGTH": 8`) tokenizes as TWO tokens here (whitespace-
// delimited), not one — so CONFIG_ASSIGNMENT_RE above (which expects the
// value glued to the same token) never applies, and the label token alone
// can clear the entropy threshold purely on its own character diversity
// (measured: `"PASSWORD_MIN_LENGTH":` scores 4.096 bits/char, just over the
// 4.0 default threshold).
//
// FEAT-463 review fix round 1 (CRITICAL, reproduced): an earlier version of
// this guard suppressed entropy on ANY token shaped like `["']?identifier
// ["']?[:=]` that merely *contained* a recognized keyword substring — but
// that shape doesn't actually prove the token is a value-less label. A
// genuine high-entropy SECRET can satisfy it too, e.g.
// `mysecrettoken1234567890abcdef=` (entropy 4.507, contains "secret"/
// "token", ends in bare `=` with nothing else). Round 1 added a "safe value
// immediately follows" requirement (`isLabelWithSafeValueFollowing` below).
//
// FEAT-463 review fix round 2 (CRITICAL, reproduced): round 1's "safe value
// follows" check trusts the NEXT token's shape alone, which is itself
// gameable — appending a plausible decoy (`mysecrettoken1234567890abcdef=
// 8`) revives the exact same leak by making the secret token look like a
// label with its value on the next token. Closing this requires a signal
// that doesn't depend on trusting adjacent-token shape: the label's OWN
// identifier text (quotes/separator stripped — the "core") must itself be
// LOW entropy. Verified by direct computation before implementing (not
// assumed): real config-label cores score well below the 4.0 default
// threshold —
//   PASSWORD_MIN_LENGTH   3.932   SECRET_SCAN_ENABLED  3.301
//   DJANGO_SECRET_KEY     3.690   OPENAI_API_KEY       3.093
//   DB_PASSWORD           3.096
// — while every secret-shaped core (the value itself, not a label) scores
// well above it, a ~0.5 bit/char margin:
//   mysecrettoken1234567890abcdef              4.444
//   my_secret_token_9f8a7b6c5d4e3f2a1b0c        4.461
//   myrandomvalue1234567890abcdef (no keyword)  4.487
// A secret-shaped core no longer passes the guard even when a decoy value
// follows it: `mysecrettoken1234567890abcdef= 8` now fails on the CORE's
// own entropy (4.444 >= threshold), falls through to the ordinary entropy
// check on the FULL token (`...abcdef=`, entropy 4.507), and is correctly
// redacted as `high_entropy`. This closes the suffix-attack class because,
// unlike round 1's check, it does not depend on trusting what follows the
// label at all.
//
// Third layer (identifier-case profile), belt-and-suspenders alongside the
// entropy margin above: the core must ALSO be either short (below the
// entropy length floor — true of every real label fixture above) or not
// densely mix lowercase letters with digits (`HEX_LIKE_MIX_RE`) — the
// hex/base62 shape real secret material takes but SCREAMING_SNAKE_CASE
// identifiers essentially never do. Guards against a hypothetical future
// core that happens to sit close to the entropy threshold.
//
// Three conditions must ALL hold to suppress entropy on a keyword-shaped
// label token: (1) a safe value (digits/boolean, optionally quoted)
// immediately follows it — the original split-token shape this guard
// exists for; (2) the label's own core text is itself low-entropy; (3) the
// core is short or doesn't have a hex-like case profile. A keyword-shaped
// token failing ANY of these — including the three original bypass repros
// (nothing follows) and all suffix-attack variants (core entropy too high)
// — falls through to the ordinary entropy check like any other token, so a
// genuinely high-entropy secret still gets redacted regardless of what
// does or doesn't sit next to it in the text. This remains a heuristic, not
// an adversarial-evasion-hardened parser, per this FEAT's regex-tier-only
// scope — but the remaining bypass surface now requires constructing a
// secret whose own identifier-shaped text is ALSO low-entropy, which is a
// materially different (and self-defeating, for an attacker: a low-entropy
// "secret" is a weak secret) requirement than round 1's.
// FEAT-473 (found empirically, not merely by inspection: the ASCII-only
// version of this regex left a curly-quoted label token — e.g.
// `“PASSWORD_MIN_LENGTH”:` — unrecognized as a label at all, so it fell
// through to the ordinary entropy check on its own raw text and got wrongly
// flagged as `high_entropy`, exactly the false-positive class this whole
// guard exists to prevent, just for a different quote style than the ASCII
// repro this guard's comment block above documents). Both optional-quote
// slots (opening, closing) now accept `ANY_QUOTE_CHAR` (detectors.ts) —
// shared, not duplicated, so this can't drift from the pattern-detector
// entries again.
const LABEL_CORE_RE = new RegExp(`^${ANY_QUOTE_CHAR}?([A-Za-z][A-Za-z0-9_]*)${ANY_QUOTE_CHAR}?[:=]$`);
const SECRET_LABEL_KEYWORD_RE = /(?:api[_-]?key|secret|token|password|passwd|pwd)/i;
const SAFE_VALUE_RE = /^(?:\d+|true|false)$/i;
const HEX_LIKE_MIX_RE = /[a-z][0-9]|[0-9][a-z]/;
// FEAT-473: strips one layer of EITHER straight or smart/curly quoting from
// the "safe value" token below (Layer 1) — a curly-quoted `“true”`/`“8”`
// following a label-shaped token must be recognized as safe the same way
// the straight-quoted `"true"`/`"8"` already is.
const QUOTE_STRIP_LEADING_RE = new RegExp(`^${ANY_QUOTE_CHAR}`);
const QUOTE_STRIP_TRAILING_RE = new RegExp(`${ANY_QUOTE_CHAR}$`);

/**
 * True if `token` (ending at offset `end` in `text`) is shaped like a
 * value-less credential label AND satisfies all three layers described
 * above. Returns false (not guarded — falls through to the ordinary
 * entropy check) if the token doesn't parse as a label, its core doesn't
 * contain a recognized keyword, the core is itself high-entropy (the
 * suffix-attack signal), the core has a hex-like case profile at length,
 * or nothing safely-typed follows it.
 */
function isLabelWithSafeValueFollowing(token: string, text: string, end: number, threshold: number): boolean {
  const coreMatch = LABEL_CORE_RE.exec(token);
  const core = coreMatch?.[1];
  if (!core) return false;
  if (!SECRET_LABEL_KEYWORD_RE.test(core)) return false;

  // Layer 2: the label's own text must be low-entropy — a genuine secret
  // hiding behind this shape is not.
  if (shannonEntropy(core) >= threshold) return false;

  // Layer 3: ...and short, or at least not hex/base62-shaped.
  if (core.length >= MIN_TOKEN_LENGTH && HEX_LIKE_MIX_RE.test(core)) return false;

  // Layer 1: a genuinely safe value must immediately follow.
  const nextMatch = /\S+/.exec(text.slice(end));
  if (!nextMatch) return false;
  const nextValue = nextMatch[0].replace(QUOTE_STRIP_LEADING_RE, '').replace(QUOTE_STRIP_TRAILING_RE, '');
  return SAFE_VALUE_RE.test(nextValue);
}

// FEAT-463 final-review note, resolved by FEAT-468 below: this stage has a
// numeric-alphabet ceiling. A string drawn uniformly from a 10-symbol
// alphabet (digits only) tops out at log2(10) ≈ 3.32 bits/char no matter how
// long or "random" it is, which sits below the 4.0 default
// `entropyThreshold` — so a purely-numeric secret (e.g. a long numeric PIN,
// account number, or digit-only API key) is invisible to Shannon entropy
// regardless of length. Digit strings can still be caught upstream by a
// labeled pattern detector (detectors.ts) or by the config-assignment/label
// guards above when they carry recognizable context; the ceiling only
// affects an UNLABELED all-digit token relying on entropy alone —
// `findNumericSecretRuns` below is the dedicated fallback for that case.
/** Shannon entropy in bits/char over the token's character distribution. */
export function shannonEntropy(token: string): number {
  if (token.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of token) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / token.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

export interface EntropyToken {
  value: string;
  start: number;
  end: number;
}

/** Split text into whitespace-delimited tokens with their [start,end) offsets. */
export function tokenize(text: string): EntropyToken[] {
  const tokens: EntropyToken[] = [];
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({ value: m[0], start: m.index, end: m.index + m[0].length });
  }
  return tokens;
}

/**
 * True if `token` should be SKIPPED (i.e. is a known false-positive shape)
 * rather than flagged as a high-entropy secret.
 */
function isGuarded(token: string, text: string, start: number, end: number, threshold: number): boolean {
  if (token.length < MIN_TOKEN_LENGTH) return true;
  if (PLACEHOLDER_RE.test(token)) return true;
  if (UUID_RE.test(token)) return true;
  if (token.includes('/') || token.includes('\\')) return true;
  if (CONFIG_ASSIGNMENT_RE.test(token)) return true;
  if (isLabelWithSafeValueFollowing(token, text, end, threshold)) return true;

  // Pure-hex 40/64-char strings (git SHA-1 / SHA-256) adjacent to a
  // commit/sha/hash/digest keyword within ~40 chars are assumed to be
  // content hashes, not secrets.
  if ((token.length === 40 || token.length === 64) && PURE_HEX_RE.test(token)) {
    const windowStart = Math.max(0, start - CONTEXT_WINDOW);
    const windowEnd = Math.min(text.length, end + CONTEXT_WINDOW);
    if (HEX_DIGEST_CONTEXT_RE.test(text.slice(windowStart, windowEnd))) {
      return true;
    }
  }

  return false;
}

export interface EntropyMatch {
  start: number;
  end: number;
  value: string;
}

/** Find entropy-based secret candidates in `text` above `threshold` bits/char. */
export function findEntropySecrets(text: string, threshold: number): EntropyMatch[] {
  const matches: EntropyMatch[] = [];
  for (const tok of tokenize(text)) {
    if (isGuarded(tok.value, text, tok.start, tok.end, threshold)) continue;
    if (shannonEntropy(tok.value) >= threshold) {
      matches.push({ start: tok.start, end: tok.end, value: tok.value });
    }
  }
  return matches;
}

// ---------------------------------------------------------------------------
// FEAT-468: numeric-secret digit-run heuristic (fixes the ceiling noted on
// `shannonEntropy` above).
//
// Design choice: a maximal-digit-run length check, NOT a per-alphabet-
// normalized entropy score. A normalized-entropy approach (divide by
// log2(10) and compare to a ratio) was considered and rejected: it can't
// tell a random-looking secret apart from a random-looking PHONE NUMBER or
// ACCOUNT NUMBER, because both score close to the alphabet's own maximum —
// there is no entropy-based signal that separates them. Length + "no
// separator interrupts the run" is the discriminating signal instead: real
// digit secrets in the wild (legacy numeric API tokens, long PINs) show up
// as one unbroken run, while every FP-corpus shape below is either
// separator-formatted (phone numbers, credit-card groups, zip+4) or simply
// shorter than the floor (unix timestamps, order IDs, squashed ISO dates).
//
// `DIGIT_RUN_RE` finds every MAXIMAL run of digit characters in the text —
// not tokenized on whitespace like `findEntropySecrets` above, so a digit
// run embedded inside a larger non-whitespace-delimited token (e.g. a
// digit-heavy legacy token glued to a short prefix) is still caught; only
// the digit substring itself is redacted, not the surrounding characters.
// ANY non-digit character — space, dash, paren, plus, dot, letter — ends a
// run, so a formatted numeric shape is exempted for free, with no separate
// separator-detection logic needed.
//
// Threshold: FEAT-468 review round 1 (MEDIUM finding) reproduced real,
// common, unlabeled 20-22 digit false positives that the original
// MIN_TOKEN_LENGTH-derived floor (20) didn't dodge — USPS Certified Mail
// tracking numbers are exactly 20 unbroken digits, USPS Priority/Express
// tracking numbers are exactly 22. Raised to 23, FP-first: still strictly
// above every non-secret digit-run length in the corpus —
//   - unix timestamps: 10 digits (seconds), 13 digits (ms)
//   - squashed ISO date+time(+ms): up to ~17 digits (YYYYMMDDHHmmssSSS)
//   - credit-card-shaped test numbers: 15 (Amex), 16 (Visa/Mastercard)
//   - zip+4 (squashed): 9 digits
//   - order/invoice/ID numbers: well under 20 in practice
//   - USPS Certified Mail (20) / Priority-Express (22) tracking numbers
// — while the FEAT-463 26-digit repro (the original motivating case) still
// clears it with margin. Accepted, documented residual: an unlabeled 20-22
// digit secret (rarer than a 23+ digit one, and shorter than any of the
// vendor-format secrets this stage's sibling detectors already catch) is
// still invisible to this heuristic. No separate config knob: see the
// stage-3 wiring note in index.ts for why.
const NUMERIC_SECRET_MIN_LENGTH = 23;
const DIGIT_RUN_RE = /\d+/g;

// FEAT-468 review round 1 (HIGH finding): the original digit-run scan had
// zero label-context awareness, so it corrupted ordinary labeled non-secret
// content — `INVOICE_NUMBER=12345678901234567890`, `"orderId":
// "12345678901234567890"`, `MAX_RETRIES=9999999999999999999999999` all got
// redacted, directly contradicting this FEAT's own scope ("the gap is
// UNLABELED numeric secrets only"). `LABEL_PREFIX_RE` mirrors the intent of
// `CONFIG_ASSIGNMENT_RE`/`isLabelWithSafeValueFollowing` above (skip a
// value that's clearly attached to a label) but generalized to
// arbitrary-length digit values instead of only single digits/booleans,
// since a numeric-run "value" is exactly the case those two guards don't
// cover (they both fire on the ENTROPY check over a whole token, not on a
// digit substring embedded inside one). Matches env-style (`KEY=`),
// YAML-style (`key: `), and JSON-style (`"key": `) label shapes immediately
// before the run, with an optional single layer of quoting on the label —
// deliberately does NOT check whether the label itself is a "secret"
// keyword: per this FEAT's scope, a labeled value (secret-shaped label or
// not) is the pattern-detector stage's job upstream, not this stage's.  A
// genuinely secret-labeled numeric value (`TOKEN=<26 digits>`) is still
// redacted — by the stage-2 `generic_credential` pattern detector, before
// stage 3 (this heuristic) ever sees the raw text; see
// `tests/security/redact.test.ts` for the pinned counter-case proving that.
//
// Bias is deliberately FP-first here, per review direction: a label-shaped
// prefix suppresses the heuristic even when the "label" is ordinary prose
// punctuation that happens to look like one (e.g. `Total: <23-digit
// number>`) — an unrealistic shape in practice, traded off against the
// HIGH-severity risk of silently corrupting real labeled IDs/config/JSON.
//
// FEAT-468 review round 2 (HITL decision — SAME-LINE ONLY, fixed a 40-char
// fixed-window design that was both too wide and too narrow at once):
// `hasLabelPrefix` no longer takes a fixed character window. Instead it
// looks back to the START OF THE CURRENT LINE (the nearest preceding `\n`,
// or offset 0) and tests only that slice.
//   - [MEDIUM, closed] the old window's `\s*` could cross a newline, so a
//     transcript header like `Summary:\n<secret>` — routine LLM output
//     formatting, not a real label on the secret — silently suppressed
//     redaction of a genuinely unlabeled secret (a false NEGATIVE, the more
//     dangerous direction for a redaction control). A digit run that starts
//     a line has an EMPTY same-line prefix, which can never match
//     `LABEL_PREFIX_RE`, so it can no longer be suppressed by anything on a
//     previous line, full stop.
//   - [LOW, closed] the old fixed 40-char window could push a real label
//     out of range if enough whitespace padding sat between the separator
//     and the value (e.g. fixed-width/aligned config: `ACCOUNT_NUMBER:
//     <40 spaces>12345...`). Same-line scanning has no length cap, so
//     `\s*` in `LABEL_PREFIX_RE` absorbs arbitrary same-line padding.
//
// FEAT-473: the three `["']?` optional-quote slots (before the label, after
// it, and after the separator before the value) are widened to
// `ANY_QUOTE_CHAR` (detectors.ts) — straight ASCII quotes plus the four
// Unicode smart/curly quote code points. Without this, a curly-quoted
// labeled numeric value (`"orderId": 12345678901234567890`) would have
// looked unlabeled to THIS heuristic specifically (even though the
// pattern-detector stage upstream never even reaches this function for a
// recognized secret keyword) and been wrongly flagged as an unlabeled
// numeric secret — the same class of false positive the ASCII-only guard
// was built to prevent for straight-quoted labels, just for a curly-quoted
// one instead. Shares the exact character set with detectors.ts's quoted
// entries rather than maintaining a second copy, so the two can't drift.
const LABEL_PREFIX_RE = new RegExp(
  `(?<![A-Za-z0-9_])${ANY_QUOTE_CHAR}?[A-Za-z][A-Za-z0-9_]*${ANY_QUOTE_CHAR}?\\s*[:=]\\s*${ANY_QUOTE_CHAR}?$`
);

/** True if `text` immediately before offset `start`, on the SAME LINE only
 * (never crossing a `\n`), looks like a `LABEL=`, `label: `, or `"label": `
 * shape — i.e. `start` is the value side of a labeled assignment, not a
 * bare unlabeled token. A digit run that opens a new line (nothing between
 * the line start and the run) always returns false here, by construction —
 * a label on a PREVIOUS line can never suppress it. */
function hasLabelPrefix(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  return LABEL_PREFIX_RE.test(text.slice(lineStart, start));
}

export interface NumericSecretMatch {
  start: number;
  end: number;
  value: string;
}

/**
 * Find every maximal run of `minLength`+ consecutive digit characters in
 * `text` that is NOT immediately preceded by a label shape (see
 * `hasLabelPrefix`). Each match is the digit substring itself (not any
 * surrounding non-digit characters in the same token).
 */
export function findNumericSecretRuns(text: string, minLength: number = NUMERIC_SECRET_MIN_LENGTH): NumericSecretMatch[] {
  const matches: NumericSecretMatch[] = [];
  DIGIT_RUN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIGIT_RUN_RE.exec(text)) !== null) {
    if (m[0].length >= minLength && !hasLabelPrefix(text, m.index)) {
      matches.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
    }
  }
  return matches;
}
