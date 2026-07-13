/**
 * A ship failure must name the LAYER that failed.
 *
 * The catch block logged `(err as Error).message` and nothing else. For a failed
 * `fetch`, Node/undici sets that message to the literal string "fetch failed" and
 * puts the real reason on `err.cause`. So the log said:
 *
 *     { "err": { "error_message": "fetch failed", "error_kind": "Unknown" } }
 *
 * ...37 times on the operator's daemon, while DNS resolved, TCP/443 connected, TLS
 * handshook and the cert was valid. Every layer we could check by hand was healthy,
 * and the log still could not say which one wasn't. The one fact that would have
 * identified it lived on `.cause` and was discarded.
 */
import { describe, it, expect } from 'vitest';
import { describeShipError } from '../../src/sync/shipper.js';

describe('describeShipError — a ship failure names the failing layer', () => {
  it('surfaces the cause + code hidden under a bare "fetch failed"', () => {
    // Exactly the shape Node/undici produces: generic TypeError, real reason on .cause.
    const inner = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: inner });

    const d = describeShipError(outer);

    // REGRESSION GUARD: the old logger produced exactly this and stopped.
    expect(d.err).toBe('fetch failed');
    // ...and now it keeps going, to the fact that actually identifies the layer.
    expect(d.err_cause).toBe('read ECONNRESET');
    expect(d.err_code).toBe('ECONNRESET');
  });

  it('walks a NESTED cause chain (undici nests TypeError -> AggregateError -> SystemError)', () => {
    const deepest = Object.assign(new Error('connect ECONNREFUSED 57.167.72.99:443'), { code: 'ECONNREFUSED' });
    const mid = Object.assign(new Error('aggregate'), { cause: deepest });
    const outer = Object.assign(new TypeError('fetch failed'), { cause: mid });

    const d = describeShipError(outer);

    expect(d.err_code).toBe('ECONNREFUSED');
    expect(d.err_cause).toContain('ECONNREFUSED');
  });

  it('an HTTP-status failure (already descriptive) is left alone — no fabricated cause', () => {
    // The shipper throws these itself with the body included; there is no `.cause`.
    const d = describeShipError(new Error('sync ship failed: HTTP 403 {"error":"sync_disabled"}'));

    expect(d.err).toContain('HTTP 403');
    expect(d.err_cause).toBeUndefined();
    expect(d.err_code).toBeUndefined();
  });

  it('does not hang on a self-referential cause chain', () => {
    const e = new Error('loop') as Error & { cause?: unknown };
    e.cause = e; // cycle
    expect(() => describeShipError(e)).not.toThrow();
  });

  it('handles a non-Error throw without crashing', () => {
    const d = describeShipError('just a string');
    expect(d.err).toBe('just a string');
  });
});
