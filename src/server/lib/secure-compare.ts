/**
 * safeBearerEqual — constant-time comparison for the incoming `Authorization`
 * header against the expected `Bearer <token>` value (FEAT-430, HARD-bearer
 * timing-safe hardening).
 *
 * The prior check (`auth !== \`Bearer ${token}\``) used JS's native string
 * `!==`, which short-circuits on the first differing byte. An attacker who
 * can measure response latency at enough precision can use that to recover
 * the bearer token one byte at a time (classic timing side-channel).
 *
 * Fix: hash both sides to a fixed-length SHA-256 digest, then compare the
 * digests with `crypto.timingSafeEqual`. Hashing first (rather than padding
 * the raw strings to a common length) sidesteps `timingSafeEqual`'s
 * "different length" throw entirely — both digests are always 32 bytes
 * regardless of the input length, so there is no length branch to leak and
 * no length-mismatch case to special-case.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

/** Constant-time string equality. Safe for missing/empty input on either side. */
export function safeBearerEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}
