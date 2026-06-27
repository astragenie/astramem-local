import { describe, it, expect } from 'vitest';
import {
  isSensitiveKey,
  scrubString,
  scrubObj,
  truncateTranscript,
} from '../../src/log/scrub.js';

// ---------------------------------------------------------------------------
// isSensitiveKey
// ---------------------------------------------------------------------------
describe('isSensitiveKey', () => {
  it('matches authorization', () => expect(isSensitiveKey('authorization')).toBe(true));
  it('matches Authorization (case-insensitive)', () => expect(isSensitiveKey('Authorization')).toBe(true));
  it('matches api_key', () => expect(isSensitiveKey('api_key')).toBe(true));
  it('matches apiKey', () => expect(isSensitiveKey('apiKey')).toBe(true));
  it('matches api-key', () => expect(isSensitiveKey('api-key')).toBe(true));
  it('matches token', () => expect(isSensitiveKey('token')).toBe(true));
  it('matches bearer', () => expect(isSensitiveKey('bearer')).toBe(true));
  it('matches BEARER (case-insensitive)', () => expect(isSensitiveKey('BEARER')).toBe(true));
  it('matches password', () => expect(isSensitiveKey('password')).toBe(true));
  it('matches secret', () => expect(isSensitiveKey('secret')).toBe(true));
  it('does not match harmless key', () => expect(isSensitiveKey('session_id')).toBe(false));
  it('does not match method', () => expect(isSensitiveKey('method')).toBe(false));
  it('does not match duration_ms', () => expect(isSensitiveKey('duration_ms')).toBe(false));
});

// ---------------------------------------------------------------------------
// scrubString
// ---------------------------------------------------------------------------
describe('scrubString', () => {
  it('redacts Bearer token', () => {
    expect(scrubString('Authorization: Bearer abc123xyz')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts Bearer inline in error message', () => {
    expect(scrubString('chat failed with bearer xyz-secret-key')).toBe(
      'chat failed with bearer [REDACTED]',
    );
  });

  it('is case-insensitive for Bearer keyword', () => {
    expect(scrubString('BEARER supersecret')).toBe('BEARER [REDACTED]');
  });

  it('redacts multiple Bearer occurrences', () => {
    const s = scrubString('Bearer abc, Bearer def');
    expect(s).toBe('Bearer [REDACTED], Bearer [REDACTED]');
  });

  it('leaves non-Bearer strings unchanged', () => {
    const s = 'session_id=abc, job_id=123';
    expect(scrubString(s)).toBe(s);
  });

  it('handles empty string', () => {
    expect(scrubString('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// scrubObj — spec-mandated test cases
// ---------------------------------------------------------------------------
describe('scrubObj — spec cases', () => {
  it('{authorization: "Bearer abc123"} → {authorization: "[REDACTED]"}', () => {
    const result = scrubObj({ authorization: 'Bearer abc123' }) as Record<string, unknown>;
    expect(result['authorization']).toBe('[REDACTED]');
  });

  it('{api_key: "sk-secret"} → {api_key: "[REDACTED]"}', () => {
    const result = scrubObj({ api_key: 'sk-secret' }) as Record<string, unknown>;
    expect(result['api_key']).toBe('[REDACTED]');
  });

  it('{MEMORY_BEARER: "tok"} — bearer matches', () => {
    // MEMORY_BEARER contains "BEARER"
    const result = scrubObj({ MEMORY_BEARER: 'supersecrettoken' }) as Record<string, unknown>;
    expect(result['MEMORY_BEARER']).toBe('[REDACTED]');
  });

  it('{password: "hunter2"} → {password: "[REDACTED]"}', () => {
    const result = scrubObj({ password: 'hunter2' }) as Record<string, unknown>;
    expect(result['password']).toBe('[REDACTED]');
  });

  it('preserves non-sensitive keys', () => {
    const result = scrubObj({
      session_id: 'abc',
      job_id: 'def',
      duration_ms: 42,
    }) as Record<string, unknown>;
    expect(result['session_id']).toBe('abc');
    expect(result['job_id']).toBe('def');
    expect(result['duration_ms']).toBe(42);
  });

  it('scrubs Bearer token inside non-sensitive string value', () => {
    const result = scrubObj({ message: 'call failed Bearer tok123' }) as Record<string, unknown>;
    expect(result['message']).toBe('call failed Bearer [REDACTED]');
  });

  it('recurses into nested objects', () => {
    const result = scrubObj({
      headers: { authorization: 'Bearer secret', 'content-type': 'application/json' },
    }) as { headers: Record<string, unknown> };
    expect(result.headers['authorization']).toBe('[REDACTED]');
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('recurses into arrays', () => {
    const result = scrubObj([{ token: 'abc' }, { session_id: 'xyz' }]) as Array<Record<string, unknown>>;
    expect(result[0]!['token']).toBe('[REDACTED]');
    expect(result[1]!['session_id']).toBe('xyz');
  });

  it('handles null and undefined', () => {
    expect(scrubObj(null)).toBeNull();
    expect(scrubObj(undefined)).toBeUndefined();
  });

  it('passes through numbers unchanged', () => {
    expect(scrubObj(42)).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// truncateTranscript
// ---------------------------------------------------------------------------
describe('truncateTranscript', () => {
  it('returns short strings unchanged', () => {
    const s = 'short string';
    expect(truncateTranscript(s)).toBe(s);
  });

  it('truncates long transcript to 200 chars + suffix', () => {
    const long = 'x'.repeat(500);
    const result = truncateTranscript(long);
    expect(result).toHaveLength(200 + '... [300 more chars]'.length);
    expect(result.startsWith('x'.repeat(200))).toBe(true);
    expect(result).toContain('... [300 more chars]');
  });

  it('handles exactly 200 chars without truncation', () => {
    const exact = 'y'.repeat(200);
    expect(truncateTranscript(exact)).toBe(exact);
  });

  it('spec case: Error: chat failed with bearer xyz → bearer [REDACTED]', () => {
    const errMsg = 'Error: chat failed with bearer xyz';
    const scrubbed = scrubString(errMsg);
    expect(scrubbed).toBe('Error: chat failed with bearer [REDACTED]');
  });

  it('spec case: long transcript in error trace → truncated to 200 chars', () => {
    const longTranscript = 'A'.repeat(1000);
    const truncated = truncateTranscript(longTranscript);
    expect(truncated.slice(0, 200)).toBe('A'.repeat(200));
    expect(truncated).toContain('... [800 more chars]');
  });
});
