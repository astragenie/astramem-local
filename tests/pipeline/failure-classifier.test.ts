import { describe, it, expect } from 'vitest';
import { classifyError } from '../../src/pipeline/failure-classifier.js';
import { TransientError, DeterministicError } from '../../src/pipeline/errors.js';

describe('classifyError', () => {
  // ── Typed errors take precedence ─────────────────────────────────────────────

  it('returns transient for explicit TransientError', () => {
    expect(classifyError(new TransientError('network blip'))).toBe('transient');
  });

  it('returns deterministic for explicit DeterministicError', () => {
    expect(classifyError(new DeterministicError('bad schema'))).toBe('deterministic');
  });

  // ── Network / connectivity heuristics ────────────────────────────────────────

  it('returns transient for ECONNREFUSED', () => {
    expect(classifyError(new Error('connect ECONNREFUSED 127.0.0.1:11434'))).toBe('transient');
  });

  it('returns transient for ETIMEDOUT', () => {
    expect(classifyError(new Error('ETIMEDOUT 10.0.0.1:443'))).toBe('transient');
  });

  it('returns transient for ECONNRESET', () => {
    expect(classifyError(new Error('read ECONNRESET'))).toBe('transient');
  });

  // ── Rate-limit / server errors ────────────────────────────────────────────────

  it('returns transient for 429 rate-limit', () => {
    expect(classifyError(new Error('rate-limited (429): too many requests'))).toBe('transient');
  });

  it('returns transient for 500 internal server error', () => {
    expect(classifyError(new Error('HTTP 500 from Ollama'))).toBe('transient');
  });

  it('returns transient for 502 bad gateway', () => {
    expect(classifyError(new Error('HTTP 502 from Azure'))).toBe('transient');
  });

  it('returns transient for 503 service unavailable', () => {
    expect(classifyError(new Error('upstream 503 temporarily unavailable'))).toBe('transient');
  });

  // ── Schema / parse errors (deterministic) ────────────────────────────────────

  it('returns deterministic for Zod parse error', () => {
    expect(classifyError(new Error('ZodError: invalid type at atoms'))).toBe('deterministic');
  });

  it('returns deterministic for JSON parse error', () => {
    expect(classifyError(new Error('Unexpected token a in JSON at position 0'))).toBe('deterministic');
  });

  it('returns deterministic for JSON.parse failure message', () => {
    expect(classifyError(new Error('JSON.parse failed: bad input'))).toBe('deterministic');
  });

  it('returns deterministic for schema validation failure', () => {
    expect(classifyError(new Error('schema validation error: missing required field'))).toBe('deterministic');
  });

  // ── 4xx HTTP errors (deterministic) ──────────────────────────────────────────

  it('returns deterministic for 400 bad request', () => {
    expect(classifyError(new Error('HTTP 400 from Azure OpenAI chat'))).toBe('deterministic');
  });

  it('returns deterministic for 401 unauthorized', () => {
    expect(classifyError(new Error('Azure OpenAI embed failed: HTTP 401 — Unauthorized'))).toBe('deterministic');
  });

  it('returns deterministic for 403 forbidden', () => {
    expect(classifyError(new Error('HTTP 403 forbidden'))).toBe('deterministic');
  });

  it('returns deterministic for 404 not found', () => {
    expect(classifyError(new Error('HTTP 404 deployment not found'))).toBe('deterministic');
  });

  // ── Edge cases ────────────────────────────────────────────────────────────────

  it('returns transient for non-Error unknown values (conservative default)', () => {
    expect(classifyError('string error')).toBe('transient');
    expect(classifyError(42)).toBe('transient');
    expect(classifyError(null)).toBe('transient');
  });

  it('returns transient for plain Error with unrecognised message (conservative default)', () => {
    expect(classifyError(new Error('something unexpected happened'))).toBe('transient');
  });

  // ── TypedError subclass identity ──────────────────────────────────────────────

  it('TransientError.is() recognises only TransientError instances', () => {
    expect(TransientError.is(new TransientError('x'))).toBe(true);
    expect(TransientError.is(new DeterministicError('x'))).toBe(false);
    expect(TransientError.is(new Error('x'))).toBe(false);
    expect(TransientError.is(null)).toBe(false);
  });

  it('DeterministicError.is() recognises only DeterministicError instances', () => {
    expect(DeterministicError.is(new DeterministicError('x'))).toBe(true);
    expect(DeterministicError.is(new TransientError('x'))).toBe(false);
    expect(DeterministicError.is(new Error('x'))).toBe(false);
    expect(DeterministicError.is(undefined)).toBe(false);
  });
});
