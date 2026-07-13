import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { defaultConfig } from '../../src/config/config.js';
import { logger } from '../../src/log/logger.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { ProposalRepo } from '../../src/consolidate/proposals.js';

const TOKEN = 'devtok';

function insertMemory(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact',
    text,
    normalized_text: text.toLowerCase(),
    repo: null, project: null, branch: null, agent: null, session_id: null,
    hash, source_hash: null,
  });
}

/** Real winner/loser memory rows behind the proposal — a genuine `accept`
 *  (not just a status-code check) requires them to exist, since
 *  `ProposalRepo.accept` runs `mergeAsSupersede` against both ids. */
function insertRealProposal(db: DB, id: string): void {
  const winnerId = insertMemory(db, `winner ${id}`, `h-${id}-w`);
  const loserId = insertMemory(db, `loser ${id}`, `h-${id}-l`);
  db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, resolved_at)
    VALUES (?, 'merge', ?, ?, 0.9, 'pending', ?, NULL)
  `).run(id, winnerId, loserId, Date.now());
}

/**
 * Dev no-auth mode (Config['auth'].devNoAuth) — token-free local access for
 * the operator's own daemon, gated by a Host-header loopback guard (the
 * DNS-rebinding defense the Bearer token was also providing) and refused
 * outright whenever the bind isn't loopback (see src/server/app.ts's
 * devNoAuthActive doc comment for why "refuse + keep booting" was chosen
 * over a hard boot-time exit).
 */
describe('dev no-auth mode', () => {
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

  describe('off (default)', () => {
    it('no Authorization header => 401, same as today', async () => {
      app = await buildApp({ db, token: TOKEN }); // defaultConfig() => auth.devNoAuth: false
      const res = await app.inject({ method: 'GET', url: '/memory/does-not-matter' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('on, loopback bind', () => {
    function buildDevNoAuthApp() {
      const config = { ...defaultConfig(), auth: { devNoAuth: true } };
      return buildApp({ db, token: TOKEN, config });
    }

    it('no Authorization header, loopback Host => 200 (auth skipped entirely)', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { host: '127.0.0.1:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('localhost Host header (with port) => 200', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { host: 'localhost:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('bracketed IPv6 loopback Host header => 200', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { host: '[::1]:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('evil.com Host header => 403, not 401 — rejected by the Host guard, not the Bearer check', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { host: 'evil.com' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ error: 'forbidden' });
    });

    // Fastify's inject() always substitutes its own default Host header when
    // none is supplied (there is no way to simulate a genuinely missing Host
    // at this layer) — the "fails closed on an unrecognized value" behavior
    // is covered directly against isLoopbackHostHeader('') in
    // tests/server/lib/network.test.ts instead.

    it('/dashboard: no credentials, loopback Host => 200 (auth skipped entirely, same as the API)', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { host: '127.0.0.1:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('/dashboard: no credentials, non-loopback Host => 403, not 401 — rejected by the Host guard', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { host: 'evil.com' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('/dashboard/jobs (sibling page): no credentials, loopback Host => 200', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/jobs',
        headers: { host: 'localhost:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('/dashboard/jobs (sibling page): non-loopback Host => 403', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/jobs',
        headers: { host: 'evil.com' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('/dashboard/consolidation (sibling page): no credentials, loopback Host => 200', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/consolidation',
        headers: { host: 'localhost:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('/dashboard/consolidation (sibling page): non-loopback Host => 403', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/consolidation',
        headers: { host: 'evil.com' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('/dashboard/search (sibling page): no credentials, loopback Host => 200', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/search',
        headers: { host: 'localhost:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('/dashboard/search (sibling page): non-loopback Host => 403', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/search',
        headers: { host: 'evil.com' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('/dashboard/api (sibling page): no credentials, loopback Host => 200', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/api',
        headers: { host: 'localhost:7777' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('/dashboard/api (sibling page): non-loopback Host => 403', async () => {
      app = await buildDevNoAuthApp();
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard/api',
        headers: { host: 'evil.com' },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // Empirically proven attack (security review, real app, devNoAuth on):
  // POST /consolidation/proposals/<id>/accept with Host: 127.0.0.1:7777 (the
  // real target — NOT a rebinding attempt), Origin: http://evil.example,
  // Content-Type: application/x-www-form-urlencoded, no credentials => 200,
  // proposal accepted. Root cause: Fastify parses the body BEFORE preHandler
  // runs (the old 415 pre-parser-fix happened to kill this pre-auth as a
  // side effect); urlencoded is a CORS "simple request" type, so a
  // cross-site page's <form> triggers no preflight; and the Host header on
  // a form POST is always the TARGET, never the page that fired it, so the
  // existing loopback-Host guard alone cannot tell this apart from the
  // dashboard's own forms. This is not consolidation-specific — it applies
  // to every mutating route while devNoAuth is active, hence the guard
  // lives in app.ts's devNoAuth preHandler branch (not just
  // dashboard-auth.ts's checkDashboardAuth).
  describe('CSRF: devNoAuth + urlencoded form POST at a real mutating API route (proven repro)', () => {
    function buildDevNoAuthApp() {
      const config = { ...defaultConfig(), auth: { devNoAuth: true } };
      return buildApp({ db, token: TOKEN, config });
    }

    it('proven repro verbatim: loopback Host + foreign Origin + urlencoded + no creds => 403, not 200 — proposal left pending', async () => {
      app = await buildDevNoAuthApp();
      insertRealProposal(db, 'prop-csrf-repro');

      const res = await app.inject({
        method: 'POST',
        url: '/consolidation/proposals/prop-csrf-repro/accept',
        headers: {
          host: '127.0.0.1:7777',
          origin: 'http://evil.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });

      expect(res.statusCode).toBe(403);
      expect(new ProposalRepo(db).get('prop-csrf-repro')?.status).toBe('pending');
    });

    it('loopback Origin => passes through, proposal genuinely accepted', async () => {
      app = await buildDevNoAuthApp();
      insertRealProposal(db, 'prop-csrf-loopback-origin');

      const res = await app.inject({
        method: 'POST',
        url: '/consolidation/proposals/prop-csrf-loopback-origin/accept',
        headers: {
          host: '127.0.0.1:7777',
          origin: 'http://127.0.0.1:7777',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });

      expect(res.statusCode).toBe(200);
      expect(new ProposalRepo(db).get('prop-csrf-loopback-origin')?.status).toBe('accepted');
    });

    it('absent Origin (curl/CLI legitimacy — the whole point of devNoAuth) => passes through, proposal genuinely accepted', async () => {
      app = await buildDevNoAuthApp();
      insertRealProposal(db, 'prop-csrf-no-origin');

      const res = await app.inject({
        method: 'POST',
        url: '/consolidation/proposals/prop-csrf-no-origin/accept',
        headers: {
          host: '127.0.0.1:7777',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });

      expect(res.statusCode).toBe(200);
      expect(new ProposalRepo(db).get('prop-csrf-no-origin')?.status).toBe('accepted');
    });

    it('Bearer mode (devNoAuth off) is unaffected by a foreign Origin header', async () => {
      app = await buildApp({ db, token: TOKEN }); // defaultConfig() => auth.devNoAuth: false
      insertRealProposal(db, 'prop-csrf-bearer-mode');

      const res = await app.inject({
        method: 'POST',
        url: '/consolidation/proposals/prop-csrf-bearer-mode/accept',
        headers: {
          authorization: `Bearer ${TOKEN}`,
          origin: 'http://evil.example',
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });

      expect(res.statusCode).toBe(200);
      expect(new ProposalRepo(db).get('prop-csrf-bearer-mode')?.status).toBe('accepted');
    });
  });

  describe('/dashboard when devNoAuth is off — existing token/cookie behavior unchanged', () => {
    it('no Authorization, no cookie, no ?token= => 401 plain text (default config)', async () => {
      app = await buildApp({ db, token: TOKEN }); // defaultConfig() => auth.devNoAuth: false
      const res = await app.inject({ method: 'GET', url: '/dashboard' });
      expect(res.statusCode).toBe(401);
      expect(res.headers['content-type']).toContain('text/plain');
    });

    it('?token=<bearer> bootstrap still redirects and sets the cookie', async () => {
      app = await buildApp({ db, token: TOKEN });
      const res = await app.inject({ method: 'GET', url: `/dashboard?token=${TOKEN}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers['set-cookie']).toContain('astramem_dash=devtok');
    });

    it('Authorization: Bearer <token> is accepted (no cookie needed)', async () => {
      app = await buildApp({ db, token: TOKEN });
      const res = await app.inject({
        method: 'GET',
        url: '/dashboard',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('refused on non-loopback bind', () => {
    it('devNoAuth: true + network.host: 0.0.0.0 => auth stays enforced (Bearer still required)', async () => {
      const config = { ...defaultConfig(), auth: { devNoAuth: true }, network: { host: '0.0.0.0' } };
      app = await buildApp({ db, token: TOKEN, config });

      const noAuth = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { host: '127.0.0.1:7777' },
      });
      expect(noAuth.statusCode).toBe(401);

      const withBearer = await app.inject({
        method: 'GET',
        url: '/whoami',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(withBearer.statusCode).toBe(200);
    });

    it('logs a loud warning at boot instead of silently activating', async () => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation((() => {}) as never);
      const config = { ...defaultConfig(), auth: { devNoAuth: true }, network: { host: '0.0.0.0' } };
      app = await buildApp({ db, token: TOKEN, config });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ host: '0.0.0.0' }),
        expect.stringContaining('refusing to skip auth'),
      );
      warnSpy.mockRestore();
    });
  });

  describe('/health observability', () => {
    it('reports auth: "dev-no-auth" when active', async () => {
      const config = { ...defaultConfig(), auth: { devNoAuth: true } };
      app = await buildApp({ db, token: TOKEN, config });
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json().auth).toBe('dev-no-auth');
    });

    it('omits the auth field when off (default)', async () => {
      app = await buildApp({ db, token: TOKEN });
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.json().auth).toBeUndefined();
    });

    it('omits the auth field when configured on but refused (non-loopback bind)', async () => {
      const config = { ...defaultConfig(), auth: { devNoAuth: true }, network: { host: '0.0.0.0' } };
      app = await buildApp({ db, token: TOKEN, config });
      const res = await app.inject({
        method: 'GET',
        url: '/health',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.json().auth).toBeUndefined();
    });
  });
});
