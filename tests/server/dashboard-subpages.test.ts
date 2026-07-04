import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'testtoken';
const AUTH = { authorization: `Bearer ${TOKEN}` };

// FEAT-410 SLICE-410-1 AC-8/AC-9: the three stub pages must be reachable
// under the widened /dashboard prefix auth exemption, and the exemption
// must not leak to unrelated paths.
describe('GET /dashboard/* prefix auth exemption + stub pages', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN });
  });

  it.each([
    ['/dashboard/consolidation'],
    ['/dashboard/jobs'],
    ['/dashboard/search'],
  ])('%s: 401 with no credentials at all', async (path) => {
    const res = await app.inject({ method: 'GET', url: path });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ['/dashboard/consolidation'],
    ['/dashboard/jobs'],
  ])('%s: 200 placeholder page with a valid Authorization bearer', async (path) => {
    const res = await app.inject({ method: 'GET', url: path, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body.toLowerCase()).toContain('coming in wave 2');
  });

  // FEAT-410 SLICE-410-6 (wave 2): /dashboard/search's render internals are no
  // longer the wave-1 placeholder — its real content is covered by
  // tests/server/dashboard-search-html.test.ts. This just confirms the
  // stable auth/registration contract from SLICE-410-1 still holds.
  it('/dashboard/search: 200 real page (no longer the wave-1 placeholder) with a valid Authorization bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/search', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it.each([
    ['/dashboard/consolidation'],
    ['/dashboard/jobs'],
    ['/dashboard/search'],
  ])('%s: 200 with only a valid dashboard cookie (no Authorization header)', async (path) => {
    // Bootstrap the cookie via the real /dashboard flow.
    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;

    const res = await app.inject({ method: 'GET', url: path, headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  it('the global preHandler does NOT reject /dashboard/consolidation with a valid cookie and no Authorization header', async () => {
    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;
    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: { cookie } });
    expect(res.statusCode).not.toBe(401);
  });

  it('the prefix exemption does not leak to unrelated paths (regression guard)', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard-not-a-real-path' });
    expect(res.statusCode).toBe(401);
  });

  it('/dashboardsomethingelse (no slash) is still auth-gated — exact prefix match only', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboardxyz' });
    expect(res.statusCode).toBe(401);
  });
});
