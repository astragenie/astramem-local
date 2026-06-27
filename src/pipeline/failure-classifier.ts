/**
 * Failure classifier for the worker retry router.
 *
 * Distinguishes transient failures (retry with backoff) from deterministic
 * failures (immediate poison — no further LLM budget spent).
 *
 * Priority:
 *   1. Explicit typed errors (TransientError / DeterministicError) — authoritative.
 *   2. Message heuristics — cover unwrapped errors from providers / stages.
 *   3. Default: transient (conservative — retry rather than silently drop).
 */

import { TransientError, DeterministicError } from './errors.js';

export type FailureKind = 'transient' | 'deterministic';

/** Heuristic substrings that classify a message as transient. */
const TRANSIENT_PATTERNS: string[] = [
  'econnrefused',
  'etimedout',
  'econnreset',
  'enetunreach',
  'ehostunreach',
  'epipe',
  'rate limit',
  'rate-limit',
  'ratelimit',
  '429',
  '500',
  '502',
  '503',
  '504',
];

/** Heuristic substrings that classify a message as deterministic. */
const DETERMINISTIC_PATTERNS: string[] = [
  'zod',
  'safeParse',
  'json parse',
  'json.parse',
  'unexpected token',
  'unexpected end of json',
  'invalid json',
  'parse error',
  'parse fail',
  'schema',
  'validation fail',
  'validation error',
  '400',
  '401',
  '403',
  '404',
  '422',
];

export function classifyError(err: unknown): FailureKind {
  // Explicit typed errors — highest authority
  if (TransientError.is(err)) return 'transient';
  if (DeterministicError.is(err)) return 'deterministic';

  if (!(err instanceof Error)) return 'transient'; // conservative default

  const m = err.message.toLowerCase();

  // Check transient patterns first (rate-limit / network errors should not be
  // misclassified as deterministic even if the message also contains "400").
  for (const p of TRANSIENT_PATTERNS) {
    if (m.includes(p)) return 'transient';
  }

  for (const p of DETERMINISTIC_PATTERNS) {
    if (m.includes(p)) return 'deterministic';
  }

  // Conservative default: retry rather than silently poison
  return 'transient';
}
