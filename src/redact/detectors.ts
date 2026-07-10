/**
 * Pattern-based secret detectors (stage-0 redaction, SEC-3/5, spec §4.2).
 *
 * Each detector is a regex run with the `d` (hasIndices) flag so that, when
 * `valueGroup` is set, we can redact JUST the captured secret value and keep
 * the surrounding key name / scheme intact (e.g. `Password=` stays, only the
 * value after it is replaced).
 */

export interface PatternDetector {
  type: string;
  /** Regex WITHOUT the 'g'/'d' flags — added automatically at match time. */
  source: string;
  flags: string;
  /** Capture group index to redact instead of the whole match (1-based). */
  valueGroup?: number;
  /**
   * Optional post-match guard on the captured value (or whole match, when
   * `valueGroup` is unset). Return false to discard the match entirely —
   * used by the compound-label credential detector (FEAT-459) to reject
   * pure-numeric/boolean values on its widened, lower-precision matches.
   */
  valueFilter?: (value: string) => boolean;
}

// ---------------------------------------------------------------------------
// PEM private-key blocks — run first, whole block redacted (spec §4.2).
// ---------------------------------------------------------------------------

export const PEM_DETECTOR: PatternDetector = {
  type: 'pem_private_key',
  source: '-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\\s\\S]*?-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----',
  flags: 's',
};

// ---------------------------------------------------------------------------
// Shared fragments for the FEAT-463 quoted/JSON-label credential entries
// (defined below, alongside their unquoted `generic_credential` siblings).
// ---------------------------------------------------------------------------

/** Same trailing-only keyword set as the unquoted `generic_credential` entry. */
const GENERIC_TRAILING_KEYWORDS = '(?:api[_-]?key|secret|token|password|passwd|pwd)';
/** Same any-segment compound-label base as the unquoted compound entry. */
const GENERIC_COMPOUND_LABEL = '(?:secret|password|passwd|pwd)(?:_[A-Za-z0-9]+)+';
/**
 * Mandatory closing quote/apostrophe on the label, then the separator —
 * `[:=]` as before, plus the PHP `=>` arrow as its own two-character
 * alternative (matching `[:=]` alone would consume only the `=` of `=>` and
 * wrongly leave a stray `>` at the start of the "value").
 *
 * FEAT-463 validation fix (MEDIUM, live-reproduced): the original
 * alternation was `(?:=>|[:=])` — plain `[:=]` still matches a bare `=`
 * even when it's actually the first character of an `=>` arrow. On
 * `'DB_PASSWORD' => 'hunter2xx'`, the bare-value sibling entry (whose
 * value pattern requires the value NOT start with a quote) tries `=>`
 * first, fails past it (the real value IS quoted), and the regex engine
 * then backtracks the alternation to `[:=]`, consuming only the `=` and
 * leaving `>` unconsumed — `>` isn't a quote, so the bare-value entry's
 * `(?!["'])` guard passes and `(\S+)` greedily captures the stray `>`
 * alone as a bogus one-character "secret", corrupting the arrow in the
 * output and inflating the redaction-log count. `=(?!>)` closes this: a
 * bare `=` is only allowed to match when it is NOT immediately followed by
 * `>` — when it is, the ONLY way to consume it is via the whole `=>`
 * alternative, which the bare-value entry's own value pattern then
 * correctly rejects (a quoted value follows), so that entry produces no
 * match at all for this input, exactly as intended. Does not affect a
 * genuine bare-value-after-arrow shape (`'DB_PASSWORD' => hunter2xx`,
 * unquoted value): `=>` matches whole and the bare-value pattern succeeds
 * directly, no backtracking involved.
 */
const QUOTED_LABEL_SEP = `["']\\s*(?:=>|:|=(?!>))\\s*`;

/** Rejects purely-numeric or boolean-literal values (config knobs, not secrets). */
function rejectNumericOrBooleanLiteral(value: string): boolean {
  return !/^\d+$/.test(value) && !/^(?:true|false)$/i.test(value);
}

// ---------------------------------------------------------------------------
// Vendor-specific token/key patterns.
// ---------------------------------------------------------------------------

export const PATTERN_DETECTORS: PatternDetector[] = [
  {
    type: 'aws_access_key',
    source: '\\bAKIA[0-9A-Z]{16}\\b',
    flags: '',
  },
  {
    type: 'github_token',
    source: '\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,255}\\b|\\bgithub_pat_[A-Za-z0-9_]{20,255}\\b',
    flags: '',
  },
  // Azure storage account key, labeled: `;AccountKey=<base64>`
  {
    type: 'azure_key',
    source: '\\bAccountKey\\s*=\\s*(\\S+)',
    flags: 'id',
    valueGroup: 1,
  },
  // Azure SAS token query param: `...&sig=<urlencoded-base64>`
  {
    type: 'azure_key',
    source: '[?&]sig=([A-Za-z0-9%+/=]{10,})',
    flags: 'id',
    valueGroup: 1,
  },
  // Bare Azure storage account key (88-char base64, no label).
  {
    type: 'azure_key',
    source: '\\b[A-Za-z0-9+/]{86}==',
    flags: '',
  },
  {
    type: 'gcp_api_key',
    source: '\\bAIza[0-9A-Za-z\\-_]{35}\\b',
    flags: '',
  },
  {
    type: 'slack_token',
    source: '\\bxox[baprs]-[0-9A-Za-z-]{10,72}\\b',
    flags: '',
  },
  // Generic `key = value` / `key: value` credential — redact value only.
  //
  // Label side uses a negative lookbehind, not `\b`, so compound
  // SCREAMING_SNAKE_CASE labels match: `\b` fails to find a boundary between
  // two word characters, so `OPENAI_API_KEY=` (keyword preceded by `_`, a
  // word char) never matched the old `\bapi[_-]?key` anchor (FEAT-459).
  // `(?<![A-Za-z])` instead only requires the char immediately before the
  // keyword NOT be a letter — underscore/digit/start-of-string/punctuation
  // all satisfy it, so `INTERNAL_SECRET=`, `X_API_KEY=`, `X_TOKEN=` all
  // match, while genuine mid-word collisions (`authtoken=`, `topsecret=`)
  // stay blocked exactly as `\b` blocked them before. The trailing
  // `\s*[:=]` requirement (immediately after the keyword, before any other
  // identifier char) is what keeps `MAX_TOKENS=`, `PORT=`, `NODE_ENV=`,
  // `LOG_LEVEL=` from matching — none of those have `[:=]` right after a
  // keyword substring. The captured value group has no minimum length: a
  // labeled match is high-confidence on the label alone, so short secrets
  // (e.g. a 17-char truncated token fragment) are redacted here regardless
  // of length — the entropy detector's MIN_TOKEN_LENGTH floor (entropy.ts)
  // only ever applies to UNLABELED values, by design (see comment there).
  //
  // This detector requires the recognized keyword to be the LAST
  // underscore-delimited segment before the separator ("trailing"), which
  // is deliberate for the two ambiguous keywords here — `token` and
  // `api[_-]?key` — because widening either to match anywhere in a compound
  // produces real false positives on common non-secret identifiers
  // (`TOKEN_LIMIT=`, `TOKEN_COUNT=`, `KEY_SIZE=`). See the next detector for
  // the higher-precision keywords, which don't have this problem.
  {
    type: 'generic_credential',
    source: '(?<![A-Za-z])(?:api[_-]?key|secret|token|password|passwd|pwd)\\s*[:=]\\s*(\\S+)',
    flags: 'id',
    valueGroup: 1,
  },
  // Compound-label credential, ANY segment position (FEAT-459 review
  // finding: the trailing-only detector above misses `SECRET_KEY=`,
  // `DJANGO_SECRET_KEY=`, `JWT_SECRET_KEY=`, `secret_key_base:` — all real,
  // common secret labels where the recognized keyword is a LEADING or
  // MIDDLE segment, not the last one). Restricted to `secret`/`password`/
  // `passwd`/`pwd` — these words are almost never benign in a label
  // regardless of position, unlike `token`/`key` above. Deliberately does
  // NOT add a bare `key` keyword (`primary_key=`, `sort_key=`, `cache_key=`
  // are common non-secret column/identifier names — see the false-positive
  // fixture for `primary_key=id`).
  //
  // Because this is lower-precision than a trailing match (the label is
  // real, but middle-segment keywords like `..._MIN_LENGTH`, `..._DAYS`,
  // `..._ENABLED` describe config knobs about a secret, not the secret
  // itself), `valueFilter` rejects purely-numeric or boolean-literal
  // values (`PASSWORD_MIN_LENGTH=8`, `SECRET_ROTATION_DAYS=30`,
  // `SECRET_SCAN_ENABLED=true` all stay unredacted). Trailing matches above
  // get no such guard — a trailing keyword IS the secret's label, at any
  // value.
  {
    type: 'generic_credential',
    source: '(?<![A-Za-z])(?:secret|password|passwd|pwd)(?:_[A-Za-z0-9]+)+\\s*[:=]\\s*(\\S+)',
    flags: 'id',
    valueGroup: 1,
    valueFilter: (value) => !/^\d+$/.test(value) && !/^(?:true|false)$/i.test(value),
  },
  // Quoted/JSON-label forms (FEAT-463 review follow-up to FEAT-459): the two
  // `generic_credential` entries above require the `[:=]` separator to
  // immediately follow the keyword — a closing quote/apostrophe on the label
  // (`"OPENAI_API_KEY":`, `'DB_PASSWORD' =>`) breaks that adjacency, so
  // JSON-config-shaped and PHP-array-shaped transcript payloads went
  // unmatched entirely. These entries tolerate a MANDATORY quote/apostrophe
  // between keyword and separator (mandatory, not optional, so they never
  // overlap the two entries above — those require the quote to be absent)
  // plus the PHP `=>` arrow as an alternative separator. Tagged with a
  // distinct `type` (not `generic_credential`) so redaction-log coverage is
  // observable by pattern shape — no schema change, just more
  // `PATTERN_DETECTORS` rows, same convention `azure_key` already uses
  // across its 3 entries above.
  //
  // Three value shapes per keyword family (trailing / compound), so 6
  // entries total: double-quoted value, single-quoted value, and bare
  // (unquoted) value. The bare-value variant excludes a leading quote via
  // `(?!["'])` so it never mis-captures a quoted value's opening quote as
  // part of a "bare" token — that shape is already handled by the two
  // quoted-value entries in the same family.
  //
  // Known limitation (regex-tier only, per this FEAT's stated non-goal of
  // full JSON/YAML AST parsing — disclosed, not a hidden gap): `[^"]*`/
  // `[^']*` have no escape awareness. A value containing an escaped inner
  // quote (`"api_key": "sk-abc\"def"`) is captured only up to the literal
  // backslash-quote, so the placeholder replaces `sk-abc\` and the
  // remainder (`def`) is left in plaintext right after it — a *partial*
  // redaction that visually looks complete. Flagged as a fast-follow, not
  // fixed here.
  {
    type: 'generic_credential_quoted',
    source: `(?<![A-Za-z])${GENERIC_TRAILING_KEYWORDS}${QUOTED_LABEL_SEP}"([^"]*)"`,
    flags: 'id',
    valueGroup: 1,
  },
  {
    type: 'generic_credential_quoted',
    source: `(?<![A-Za-z])${GENERIC_TRAILING_KEYWORDS}${QUOTED_LABEL_SEP}'([^']*)'`,
    flags: 'id',
    valueGroup: 1,
  },
  {
    type: 'generic_credential_quoted',
    source: `(?<![A-Za-z])${GENERIC_TRAILING_KEYWORDS}${QUOTED_LABEL_SEP}(?!["'])(\\S+)`,
    flags: 'id',
    valueGroup: 1,
  },
  // Compound-label quoted forms mirror the any-segment `generic_credential`
  // entry above: same numeric/boolean `valueFilter` guard (a quoted label
  // doesn't make a config-knob value any more secret than an unquoted one —
  // AC-3: `"PASSWORD_MIN_LENGTH": 8`, `"SECRET_SCAN_ENABLED": "true"` must
  // stay unredacted).
  {
    type: 'generic_credential_quoted',
    source: `(?<![A-Za-z])${GENERIC_COMPOUND_LABEL}${QUOTED_LABEL_SEP}"([^"]*)"`,
    flags: 'id',
    valueGroup: 1,
    valueFilter: rejectNumericOrBooleanLiteral,
  },
  {
    type: 'generic_credential_quoted',
    source: `(?<![A-Za-z])${GENERIC_COMPOUND_LABEL}${QUOTED_LABEL_SEP}'([^']*)'`,
    flags: 'id',
    valueGroup: 1,
    valueFilter: rejectNumericOrBooleanLiteral,
  },
  {
    type: 'generic_credential_quoted',
    source: `(?<![A-Za-z])${GENERIC_COMPOUND_LABEL}${QUOTED_LABEL_SEP}(?!["'])(\\S+)`,
    flags: 'id',
    valueGroup: 1,
    valueFilter: rejectNumericOrBooleanLiteral,
  },
  {
    type: 'jwt',
    source: '\\bey[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\b',
    flags: '',
  },
  // Connection-string userinfo: scheme://user:pass@ — redact the "user:pass" span.
  {
    type: 'connection_string',
    source: '\\b[a-zA-Z][a-zA-Z0-9+.-]*://([^/\\s:@]+:[^/\\s@]+)@',
    flags: 'd',
    valueGroup: 1,
  },
];

/** Build a `custom` detector from a user-supplied regex source string. */
export function customDetector(source: string): PatternDetector {
  return { type: 'custom', source, flags: 'g' };
}
