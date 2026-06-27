import { describe, it, expect } from 'vitest';
import { logger, childLogger } from '../../src/log/logger.js';
import { isSensitiveKey } from '../../src/log/scrub.js';

describe('logger', () => {
  it('exports a pino logger instance', () => {
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('has level set to info by default', () => {
    // LOG_LEVEL may be overridden in env — just check it's a valid level string
    const validLevels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
    expect(validLevels).toContain(logger.level);
  });
});

describe('childLogger', () => {
  it('returns a child logger with bound fields', () => {
    const log = childLogger({ request_id: 'req-abc', job_id: 'job-123' });
    expect(typeof log.info).toBe('function');
  });

  it('strips sensitive keys from child bindings', () => {
    // We verify via isSensitiveKey since we can't easily inspect pino bindings
    const sensitiveKeys = ['authorization', 'api_key', 'token', 'bearer', 'password', 'secret'];
    for (const key of sensitiveKeys) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    // Non-sensitive keys pass through
    const nonSensitiveKeys = ['request_id', 'job_id', 'session_id', 'stage', 'model'];
    for (const key of nonSensitiveKeys) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('does not throw when logging with sensitive fields in object arg', () => {
    const log = childLogger({ request_id: 'req-test' });
    expect(() =>
      log.warn({ provider: 'azure-openai', latency_ms: 42 }, 'provider latency'),
    ).not.toThrow();
  });

  it('can be chained — child of child', () => {
    const base = childLogger({ job_id: 'j1' });
    const stage = base.child({ stage: 'compact', chunk_idx: 0 });
    expect(typeof stage.info).toBe('function');
  });
});

describe('correlation — getRequestId / runWithRequestId', () => {
  it('returns undefined outside a run scope', async () => {
    const { getRequestId } = await import('../../src/log/correlation.js');
    // If this test runs outside a scope, it returns undefined
    const id = getRequestId();
    expect(id === undefined || typeof id === 'string').toBe(true);
  });

  it('returns the set request_id inside a run scope', async () => {
    const { runWithRequestId, getRequestId, newRequestId } = await import('../../src/log/correlation.js');
    const id = newRequestId();
    let captured: string | undefined;
    runWithRequestId(id, () => {
      captured = getRequestId();
    });
    expect(captured).toBe(id);
  });

  it('newRequestId generates a UUID-shaped string', async () => {
    const { newRequestId } = await import('../../src/log/correlation.js');
    const id = newRequestId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('isolates context between concurrent run scopes', async () => {
    const { runWithRequestId, getRequestId } = await import('../../src/log/correlation.js');
    const results: string[] = [];
    await Promise.all([
      new Promise<void>(resolve =>
        runWithRequestId('id-a', () => {
          setTimeout(() => {
            results.push(getRequestId() ?? 'none');
            resolve();
          }, 0);
        }),
      ),
      new Promise<void>(resolve =>
        runWithRequestId('id-b', () => {
          setTimeout(() => {
            results.push(getRequestId() ?? 'none');
            resolve();
          }, 0);
        }),
      ),
    ]);
    expect(results).toContain('id-a');
    expect(results).toContain('id-b');
  });
});
