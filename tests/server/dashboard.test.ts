import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import type { DB } from '../../src/storage/db.js';

describe('GET /dashboard', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'testtoken' });
  });

  // (a) No token → 401 plain text
  it('returns 401 plain text when token is absent', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toContain('401');
    // Must NOT be HTML
    expect(res.body).not.toContain('<html');
  });

  it('returns 401 plain text when token is wrong', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=wrongtoken' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).not.toContain('<html');
  });

  // (b) Valid token → 200 + text/html + expected sections
  it('returns 200 with text/html content-type for valid token', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-type']).toMatch(/utf-8/);
  });

  it('HTML body contains Memory counts section header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).toContain('memory counts');
  });

  it('HTML body contains Recent captures section header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).toContain('recent captures');
  });

  it('HTML body contains Job queue section header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).toContain('job queue');
  });

  it('HTML body contains Distill throughput section header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).toContain('distill throughput');
  });

  it('HTML body contains Provider state section header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).toContain('provider state');
  });

  it('HTML body contains Budget section header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).toContain('budget');
  });

  it('HTML body contains Pending queue section header', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).toContain('pending queue');
  });

  // (c) meta refresh tag present with content="5"
  it('HTML includes meta refresh tag with content="5"', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body).toContain('<meta http-equiv="refresh"');
    expect(res.body).toContain('content="5"');
  });

  it('HTML contains a <title> tag', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body).toContain('<title>');
  });

  it('HTML contains no <script> tags', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    expect(res.body.toLowerCase()).not.toContain('<script');
  });

  it('cache-control is no-store', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
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

  // Dashboard must not be accessible without token (Authorization header alone is insufficient)
  it('returns 401 when only Authorization header is supplied (no ?token=)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard',
      headers: { authorization: 'Bearer testtoken' },
    });
    // The preHandler skips /dashboard; the route itself requires ?token=
    expect(res.statusCode).toBe(401);
  });
});
