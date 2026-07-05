import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';
import { safeBearerEqual } from '../../src/server/lib/secure-compare.js';

/**
 * FEAT-430 — Bearer auth must use a constant-time compare, not `!==`.
 *
 * Route under test: /health with a non-local bind (mirrors
 * tests/server/remote-health-auth.test.ts, FEAT-406) — the simplest route
 * that is unconditionally gated by the same `preHandler` hook every other
 * authenticated route shares, so a pass here is a pass for the shared hook.
 */
describe('FEAT-430: Bearer auth is constant-time', () => {
  const TOKEN = 'devtok-correct-token-value';
  let db: DB;
  let app: FastifyInstance;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  const nonLocalConfig = () => ({ ...defaultConfig(), network: { host: '0.0.0.0' } });

  it('correct token => 200 (authorized)', async () => {
    app = await buildApp({ db, token: TOKEN, config: nonLocalConfig() });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('wrong token, same length as correct => 401', async () => {
    app = await buildApp({ db, token: TOKEN, config: nonLocalConfig() });
    const wrongSameLength = 'x'.repeat(TOKEN.length);
    expect(wrongSameLength.length).toBe(TOKEN.length);
    expect(wrongSameLength).not.toBe(TOKEN);
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${wrongSameLength}` },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('wrong token, different length than correct => 401', async () => {
    app = await buildApp({ db, token: TOKEN, config: nonLocalConfig() });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer short' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('missing Authorization header => 401', async () => {
    app = await buildApp({ db, token: TOKEN, config: nonLocalConfig() });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });
});

describe('safeBearerEqual (unit)', () => {
  it('returns true for identical strings', () => {
    expect(safeBearerEqual('Bearer abc123', 'Bearer abc123')).toBe(true);
  });

  it('returns false for same-length mismatched strings', () => {
    expect(safeBearerEqual('Bearer aaaaaa', 'Bearer bbbbbb')).toBe(false);
  });

  it('returns false for different-length strings (no throw)', () => {
    expect(() => safeBearerEqual('Bearer a', 'Bearer much-longer-value')).not.toThrow();
    expect(safeBearerEqual('Bearer a', 'Bearer much-longer-value')).toBe(false);
  });

  it('returns false when one side is empty', () => {
    expect(safeBearerEqual('', 'Bearer abc123')).toBe(false);
  });

  it('returns true when both sides are empty', () => {
    expect(safeBearerEqual('', '')).toBe(true);
  });
});
