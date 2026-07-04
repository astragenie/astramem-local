import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';
import { isLoopbackHost } from '../../src/server/lib/network.js';

const TOKEN = 'devtok';

/**
 * FEAT-406 — remote /health scrape with auth.
 *
 * Auth-boundary rule under test: /health and /version stay public ONLY
 * while config.network.host is loopback (default 127.0.0.1). Opting into a
 * non-local bind requires Bearer auth on BOTH routes, gated together by the
 * same isLoopbackHost predicate the daemon uses to decide its own listen
 * host (src/cli/serve.ts) — no independent flag that can drift out of sync.
 */
describe('FEAT-406: remote /health scrape auth boundary', () => {
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

  // AC-1: default config — loopback-only, /health + /version stay public
  // (regression snapshot: current behavior preserved).
  it('AC-1: default config keeps /health public (no Bearer required)', async () => {
    app = await buildApp({ db, token: TOKEN }); // no config override => defaultConfig()
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('AC-1: default config keeps /version public (no Bearer required)', async () => {
    app = await buildApp({ db, token: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
  });

  it('AC-1: explicit loopback host (127.0.0.1) also stays public', async () => {
    const config = { ...defaultConfig(), network: { host: '127.0.0.1' } };
    app = await buildApp({ db, token: TOKEN, config });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  // AC-2: non-local bind + no Authorization header => 401.
  it('AC-2: non-local bind, GET /health without Bearer => 401', async () => {
    const config = { ...defaultConfig(), network: { host: '0.0.0.0' } };
    app = await buildApp({ db, token: TOKEN, config });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  // AC-3: non-local bind + correct Bearer => 200 with the health body.
  it('AC-3: non-local bind, GET /health with valid Bearer => 200 with health body', async () => {
    const config = { ...defaultConfig(), network: { host: '0.0.0.0' } };
    app = await buildApp({ db, token: TOKEN, config });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBeDefined();
  });

  // AC-4: non-local bind + wrong/expired Bearer => 401 (not 200, not 500).
  it('AC-4: non-local bind, GET /health with wrong Bearer => 401', async () => {
    const config = { ...defaultConfig(), network: { host: '0.0.0.0' } };
    app = await buildApp({ db, token: TOKEN, config });
    const res = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  // AC-5: /version follows the identical rule as /health — gated together,
  // no public-endpoint gap.
  describe('AC-5: /version parity with /health under non-local bind', () => {
    const config = { ...defaultConfig(), network: { host: '0.0.0.0' } };

    it('no Bearer => 401', async () => {
      app = await buildApp({ db, token: TOKEN, config });
      const res = await app.inject({ method: 'GET', url: '/version' });
      expect(res.statusCode).toBe(401);
    });

    it('valid Bearer => 200', async () => {
      app = await buildApp({ db, token: TOKEN, config });
      const res = await app.inject({
        method: 'GET',
        url: '/version',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('astramemory-local');
    });

    it('wrong Bearer => 401', async () => {
      app = await buildApp({ db, token: TOKEN, config });
      const res = await app.inject({
        method: 'GET',
        url: '/version',
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // /dashboard keeps its own ?token= mechanism regardless of bind — the
  // global Bearer preHandler hook still exempts the path (as it always has)
  // and dashboard's own token check governs 401/200, unchanged by FEAT-406.
  it('non-local bind: /dashboard is unaffected — no Bearer header needed, its own ?token= still governs access', async () => {
    const config = { ...defaultConfig(), network: { host: '0.0.0.0' } };
    app = await buildApp({ db, token: TOKEN, config });
    // No Authorization header at all — if the global Bearer hook applied to
    // /dashboard, this would 401 with {error:'unauthorized'}. Instead it
    // reaches the route's own token check, which 401s with a different body.
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(401);
    // The global Bearer hook's 401 body is JSON {error:'unauthorized'};
    // dashboard's own 401 is plain text — confirms the route's own check
    // fired, not the global hook.
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.payload).not.toContain('"error":"unauthorized"');
  });
});

describe('isLoopbackHost', () => {
  it.each(['127.0.0.1', 'localhost', '::1', 'LOCALHOST'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each(['0.0.0.0', '192.168.1.5', 'example.com', ''])('%s is not loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });
});

// AC-6: a threat-model doc exists and states what a non-local /health scrape
// exposes and where the auth boundary sits.
describe('AC-6: threat-model doc', () => {
  const docPath = join(process.cwd(), 'docs', 'security', 'remote-health-threat-model.md');

  it('exists', () => {
    expect(existsSync(docPath)).toBe(true);
  });

  it('documents what a non-local scrape exposes and the auth boundary', () => {
    const text = readFileSync(docPath, 'utf8').toLowerCase();
    expect(text).toContain('exposes');
    expect(text).toContain('bearer');
    expect(text).toContain('network.host');
  });
});
