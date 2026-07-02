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
  {
    type: 'generic_credential',
    source: '\\b(?:api[_-]?key|secret|token|password|passwd|pwd)\\s*[:=]\\s*(\\S+)',
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
