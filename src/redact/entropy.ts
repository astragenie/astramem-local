/**
 * Shannon-entropy secret detector (stage-0 redaction, SEC-3/5).
 *
 * Runs LAST, over whatever text survives the pattern-detector pass — catches
 * high-randomness tokens (raw keys, unlabeled secrets) that don't match a
 * known vendor format. False-positive guards keep it from flagging git SHAs,
 * UUIDs, and file paths (see redactText doc-comment for the full list).
 */

const MIN_TOKEN_LENGTH = 20;
const CONTEXT_WINDOW = 40;
const HEX_DIGEST_CONTEXT_RE = /\b(commit|sha|hash|digest)\b/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURE_HEX_RE = /^[0-9a-f]+$/i;
const PLACEHOLDER_RE = /^\[REDACTED:[^\]]+\]$/;

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
