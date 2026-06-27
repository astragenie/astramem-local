/**
 * Secret scrubber — redacts sensitive fields and strings before they reach log output.
 *
 * Apply to:
 *   - Log line objects   : scrubObj(obj)
 *   - Error message strings: scrubString(str)
 *
 * Redact patterns (case-insensitive):
 *   - Bearer tokens:  Bearer\s+\S+  →  Bearer [REDACTED]
 *   - Key fields matching /api[_-]?key/i, /token/i, /bearer/i, /password/i, /secret/i  → '[REDACTED]'
 *   - Transcript content in error contexts: truncate to first 200 chars
 */

/**
 * Regex that matches a Bearer token value in a string.
 * Group 1 captures the keyword (preserving original case).
 * Token characters: alphanumeric, ., -, _, +, /, = (covers base64, hex, JWT segments).
 * Does NOT consume trailing punctuation (commas, semicolons, quotes).
 */
const BEARER_PATTERN = /(Bearer)\s+[A-Za-z0-9._\-+/=]+/gi;

/**
 * Field-name patterns whose string values should be fully redacted.
 * Checked against the JSON key (case-insensitive).
 */
const SENSITIVE_KEY_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /token/i,
  /bearer/i,
  /password/i,
  /secret/i,
  /authorization/i,
];

/** Maximum length of transcript content in error strings before truncation. */
const TRANSCRIPT_TRUNCATE = 200;

/**
 * Returns true if this object key name matches any sensitive-field pattern.
 */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some(p => p.test(key));
}

/**
 * Redact Bearer tokens and other sensitive patterns inside a plain string.
 * Does NOT mutate; returns a new string.
 */
export function scrubString(value: string): string {
  // $1 preserves the original case of the keyword (e.g. "bearer", "BEARER", "Bearer")
  return value.replace(BEARER_PATTERN, '$1 [REDACTED]');
}

/**
 * Truncate a transcript string to TRANSCRIPT_TRUNCATE chars for error contexts.
 */
export function truncateTranscript(value: string): string {
  if (value.length <= TRANSCRIPT_TRUNCATE) return value;
  const remaining = value.length - TRANSCRIPT_TRUNCATE;
  return `${value.slice(0, TRANSCRIPT_TRUNCATE)}... [${remaining} more chars]`;
}

/**
 * Deep-clone a log record, redacting sensitive fields.
 * - String values for sensitive keys → '[REDACTED]'
 * - String values for any key → Bearer tokens scrubbed
 * - Nested objects are recursed
 * - Non-object types are returned as-is
 */
export function scrubObj(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => scrubObj(item));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveKey(key)) {
        // Redact the value entirely regardless of type
        result[key] = '[REDACTED]';
      } else if (typeof val === 'string') {
        result[key] = scrubString(val);
      } else {
        result[key] = scrubObj(val);
      }
    }
    return result;
  }

  if (typeof obj === 'string') {
    return scrubString(obj);
  }

  return obj;
}
