import { describe, it, expect } from 'vitest';
import { parseRetryAfterMs } from '../../src/providers/llm/retry-after.js';

describe('parseRetryAfterMs', () => {
  it('returns undefined for a null/undefined/empty header', () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs('')).toBeUndefined();
    expect(parseRetryAfterMs('   ')).toBeUndefined();
  });

  it('parses a delta-seconds integer into milliseconds', () => {
    expect(parseRetryAfterMs('30')).toBe(30_000);
    expect(parseRetryAfterMs('0')).toBe(0);
    expect(parseRetryAfterMs('1')).toBe(1000);
  });

  it('parses an HTTP-date into a positive millisecond delta from now', () => {
    const future = new Date(Date.now() + 10_000);
    const ms = parseRetryAfterMs(future.toUTCString());
    expect(ms).toBeGreaterThan(8000);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it('returns undefined for a date in the past (already-elapsed Retry-After)', () => {
    const past = new Date(Date.now() - 10_000);
    expect(parseRetryAfterMs(past.toUTCString())).toBeUndefined();
  });

  it('returns undefined for garbage input', () => {
    expect(parseRetryAfterMs('not-a-number-or-date')).toBeUndefined();
    expect(parseRetryAfterMs('-5')).toBeUndefined();
  });

  it('clamps a pathologically large delta-seconds value to the safety cap', () => {
    // 1 week in seconds — must not be honored verbatim; a broken/malicious
    // upstream must not be able to wedge a job's retry indefinitely.
    const oneWeekSeconds = 7 * 24 * 60 * 60;
    const result = parseRetryAfterMs(String(oneWeekSeconds));
    expect(result).toBeLessThanOrEqual(5 * 60_000);
  });
});
