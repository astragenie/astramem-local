import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import type { DB } from '../../src/storage/db.js';

const AUTH = { authorization: 'Bearer testtoken' };

describe('GET /dashboard', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'testtoken' });
  });

  // (a) No credentials → 401 plain text
  it('returns 401 plain text when no credentials are supplied', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toContain('401');
    // Must NOT be HTML
    expect(res.body).not.toContain('<html');
  });

  it('returns 401 plain text when query token is wrong', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=wrongtoken' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).not.toContain('<html');
  });

  it('returns 401 when Authorization bearer is wrong', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { authorization: 'Bearer wrongtoken' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when cookie value is wrong', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { cookie: 'astramem_dash=wrongtoken' },
    });
    expect(res.statusCode).toBe(401);
  });

  // (b) Bootstrap: valid ?token= → 302 + HttpOnly cookie + clean Location.
  // The bearer must NOT stay in the URL (browser history / meta-refresh re-send).
  it('valid ?token= redirects to the clean URL and sets an HttpOnly cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/dashboard');
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain('astramem_dash=testtoken');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/dashboard');
  });

  it('the bootstrap cookie authenticates the follow-up request', async () => {
    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  // (c) Authorization header works like every other route
  it('returns 200 with text/html for a valid Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-type']).toMatch(/utf-8/);
  });

  // (d) Rendered HTML content
  it.each([
    'memory counts',
    'recent captures',
    'job queue',
    'distill throughput',
    'provider state',
    'budget',
    'pending queue',
  ])('HTML body contains "%s" section header', async section => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: AUTH });
    expect(res.body.toLowerCase()).toContain(section);
  });

  it('HTML includes meta refresh tag with content="5"', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: AUTH });
    expect(res.body).toContain('<meta http-equiv="refresh"');
    expect(res.body).toContain('content="5"');
  });

  it('HTML contains a <title> tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: AUTH });
    expect(res.body).toContain('<title>');
  });

  it('HTML contains no <script> tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: AUTH });
    expect(res.body.toLowerCase()).not.toContain('<script');
  });

  it('cache-control is no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard', headers: AUTH });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  // Confirm /health and /version remain public (no regression)
  it('/health is still public (no token required)', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
  });

  it('/version is still public (no token required)', async () => {
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
  });
});
