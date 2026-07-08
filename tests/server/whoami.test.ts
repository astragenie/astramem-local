import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';

const TOKEN = 'devtok';

/**
 * Issue #129: `/whoami` is a bearer-verification probe. Unlike `/health` and
 * `/version`, it is never exempted from the global `preHandler` auth hook
 * (src/server/app.ts) — it requires `Authorization: Bearer <token>` on every
 * bind, including the default loopback bind where `/health` is public. That
 * asymmetry is the whole point: it lets `connect` flows confirm a bearer
 * actually works, which `/health` can't do on a default install.
 */
describe('GET /whoami', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN }); // default config => loopback bind
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('no Authorization header => 401, even on loopback (unlike /health)', async () => {
    const res = await app.inject({ method: 'GET', url: '/whoami' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('wrong Bearer token => 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('correct Bearer token => 200 with authenticated identity echo', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { authenticated: boolean; service: string; version: string };
    expect(body.authenticated).toBe(true);
    expect(body.service).toBe('astramemory-local');
    expect(typeof body.version).toBe('string');
  });

  it('does not echo the token or Authorization header back in the body', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/whoami',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.payload).not.toContain(TOKEN);
  });

  // Anchor/contrast: confirms the loopback public-path exemption for /health
  // is untouched by adding /whoami — no regression.
  it('(contrast) GET /health with no token on loopback is still public => 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });
});
