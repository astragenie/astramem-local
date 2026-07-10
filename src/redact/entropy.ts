/**
 * Shannon-entropy secret detector (stage-0 redaction, SEC-3/5).
 *
 * Runs LAST, over whatever text survives the pattern-detector pass — catches
 * high-randomness tokens (raw keys, unlabeled secrets) that don't match a
 * known vendor format. False-positive guards keep it from flagging git SHAs,
 * UUIDs, and file paths (see redactText doc-comment for the full list).
 */

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
// FEAT-463 review fix (CRITICAL, reproduced): an earlier version of this
// guard suppressed entropy on ANY token shaped like `["']?identifier["']?
// [:=]` that merely *contained* a recognized keyword substring — but that
// shape doesn't actually prove the token is a value-less label. A genuine
// high-entropy SECRET can satisfy it too, e.g.
// `mysecrettoken1234567890abcdef=` (entropy 4.507, contains "secret"/
// "token", ends in bare `=` with nothing else) — the trailing `=`/`:` need
// not be base64 padding or a real separator, it can just be incidental
// punctuation glued onto the value itself, and "secret"/"token"/"key" are
// common substrings of real vendor token *values*, not just labels. Nor
// does requiring the keyword to be an exact underscore-delimited segment
// close this: `my_secret_token_9f8a7b6c5d4e3f2a1b0c=` has "secret"/"token"
// as clean segments and is still a bona fide secret, not a label.
//
// The only reliable signal that a keyword-shaped token is GENUINELY a
// value-less label (not itself the secret) is that a plausible, safely-
// shaped value immediately follows it — replicating the exact split-token
// context this guard exists for (`"PASSWORD_MIN_LENGTH": 8`,
// `"SECRET_SCAN_ENABLED": "true"`). A keyword-shaped token with nothing
// safe following — including nothing following at all, which is exactly
// the shape of the three bypass repros above — is NOT guarded here: it
// falls through to the ordinary entropy check like any other token, so a
// genuinely high-entropy secret still gets redacted. (Note: this remains a
// heuristic, not an adversarial-evasion-hardened parser, per this FEAT's
// regex-tier-only scope — an attacker who deliberately appends a short
// numeric/boolean token after a crafted secret could still exploit this
// exact split-token shape; that residual is the same one the reviewer's
// own proposed fix direction carries, and is out of scope here.)
const LABEL_ONLY_RE = /^["']?[A-Za-z][A-Za-z0-9_]*["']?[:=]$/;
const SECRET_LABEL_KEYWORD_RE = /(?:api[_-]?key|secret|token|password|passwd|pwd)/i;
const SAFE_VALUE_RE = /^(?:\d+|true|false)$/i;

/**
 * True if `token` (ending at offset `end` in `text`) is shaped like a
 * value-less credential label AND is immediately followed by a safely-typed
 * value (digits or a boolean literal, optionally quoted) — the genuine
 * `"PASSWORD_MIN_LENGTH": 8` split-token shape. Returns false (not guarded)
 * if nothing follows, or what follows isn't a safe value shape — including
 * for a token that IS itself the whole secret.
 */
function isLabelWithSafeValueFollowing(token: string, text: string, end: number): boolean {
  if (!LABEL_ONLY_RE.test(token) || !SECRET_LABEL_KEYWORD_RE.test(token)) return false;
  const nextMatch = /\S+/.exec(text.slice(end));
  if (!nextMatch) return false;
  const nextValue = nextMatch[0].replace(/^["']/, '').replace(/["']$/, '');
  return SAFE_VALUE_RE.test(nextValue);
}

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
function isGuarded(token: string, text: string, start: number, end: number): boolean {
  if (token.length < MIN_TOKEN_LENGTH) return true;
  if (PLACEHOLDER_RE.test(token)) return true;
  if (UUID_RE.test(token)) return true;
  if (token.includes('/') || token.includes('\\')) return true;
  if (CONFIG_ASSIGNMENT_RE.test(token)) return true;
  if (isLabelWithSafeValueFollowing(token, text, end)) return true;

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
    if (isGuarded(tok.value, text, tok.start, tok.end)) continue;
    if (shannonEntropy(tok.value) >= threshold) {
      matches.push({ start: tok.start, end: tok.end, value: tok.value });
    }
  }
  return matches;
}
