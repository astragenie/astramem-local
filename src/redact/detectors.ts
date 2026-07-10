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
  {
    type: 'generic_credential',
    source: '(?<![A-Za-z])(?:api[_-]?key|secret|token|password|passwd|pwd)\\s*[:=]\\s*(\\S+)',
    flags: 'id',
    valueGroup: 1,
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
