import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { ProposalRepo } from '../../src/consolidate/proposals.js';
import { defaultConfig } from '../../src/config/config.js';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'testtoken';
const AUTH = { authorization: `Bearer ${TOKEN}` };

function insertMemory(repo: MemoryRepo, text: string, hash: string): string {
  return repo.insert({
    type: 'fact',
    text,
    normalized_text: text.toLowerCase(),
    repo: null, project: null, branch: null, agent: null, session_id: null,
    hash, source_hash: null,
  });
}

function insertProposal(
  db: DB,
  opts: { id: string; winnerId: string; loserId: string; similarity: number; kind?: 'merge' | 'contradiction'; createdAt?: number },
): void {
  db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL)
  `).run(opts.id, opts.kind ?? 'merge', opts.winnerId, opts.loserId, opts.similarity, opts.createdAt ?? Date.now());
}

// FEAT-410 SLICE-410-2: consolidation page render internals (list + accept/reject).
describe('GET /dashboard/consolidation — pending list + accept/reject', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN });
  });

  // AC-1
  it('renders id/kind/sim/both excerpts for a pending merge proposal, HTML-escaped', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'we use blue/green <deploys> & "canary" releases', 'h-winner');
    const loserId = insertMemory(repo, 'prod deploy runs nightly at 2am', 'h-loser');
    insertProposal(db, { id: 'prop-1', winnerId, loserId, similarity: 0.94 });

    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.body;

    expect(body).toContain('prop-1');
    expect(body).toContain('merge');
    expect(body).toContain('0.94');
    // Excerpt text present and HTML-escaped (no raw <, >, or unescaped &/").
    expect(body).toContain('we use blue/green');
    expect(body).toContain('&lt;deploys&gt;');
    expect(body).toContain('&amp;');
    expect(body).toContain('&quot;canary&quot;');
    expect(body).not.toContain('<deploys>');
    expect(body).toContain('prod deploy runs nightly');
  });

  // AC-2
  it('shows an explicit "No pending proposals" state when there are none, not an empty table', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toContain('no pending proposals');
    expect(res.body).not.toContain('<table>');
  });

  // AC-3
  it('row forms target the dashboard-scoped accept/reject endpoints, and resolving via cookie reflects the new status on the next GET', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner text', 'h-w2');
    const loserId = insertMemory(repo, 'loser text', 'h-l2');
    insertProposal(db, { id: 'prop-2', winnerId, loserId, similarity: 0.8 });

    const before = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(before.body).toContain('action="/dashboard/consolidation/proposals/prop-2/accept"');
    expect(before.body).toContain('action="/dashboard/consolidation/proposals/prop-2/reject"');
    expect(before.body).toContain('Consolidation — pending: 1');

    // Real-browser flow: bootstrap the session cookie the way the dashboard's
    // own nav does, then submit the row's own form target with only the
    // cookie attached (no Authorization header — a plain <form> can't send one).
    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;

    const accept = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-2/accept',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(accept.statusCode).toBe(303);
    expect(accept.headers.location).toBe('/dashboard/consolidation');

    const after = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(after.body).not.toContain('prop-2');
    expect(after.body.toLowerCase()).toContain('no pending proposals');
  });

  it('regression: the OLD Bearer-only API route (src/server/routes/consolidation.ts) still accepts a urlencoded form POST', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner text form', 'h-w3');
    const loserId = insertMemory(repo, 'loser text form', 'h-l3');
    insertProposal(db, { id: 'prop-form', winnerId, loserId, similarity: 0.8 });

    // Exactly what a browser sends for <form method="post"> with no fields:
    // urlencoded content-type and an empty body. Regression: this 415'd with
    // FST_ERR_CTP_INVALID_MEDIA_TYPE before app.ts registered a parser. The
    // dashboard's own forms no longer target this route (see AC-3 above),
    // but it stays reachable verbatim for programmatic Bearer clients.
    const accept = await app.inject({
      method: 'POST',
      url: '/consolidation/proposals/prop-form/accept',
      headers: { ...AUTH, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(accept.statusCode).toBe(200);
  });

  // AC-4
  it('returns 401 with no Authorization header and no dashboard cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation' });
    expect(res.statusCode).toBe(401);
  });

  // AC-5
  it('returns 200 with only a valid dashboard cookie (no Bearer)', async () => {
    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;
    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: { cookie } });
    expect(res.statusCode).toBe(200);
  });

  // AC-6 — the accept/reject endpoints this page's forms target
  // (src/server/routes/consolidation.ts, out of this slice's scope) already
  // turn races into structured JSON errors rather than a raw crash body;
  // this locks that contract in from the page's perspective since the page
  // has no server-rendered error path of its own (zero-JS design — see
  // file header).
  it('an already-resolved proposal race returns a structured 409, not a raw crash body', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner text', 'h-w3');
    const loserId = insertMemory(repo, 'loser text', 'h-l3');
    insertProposal(db, { id: 'prop-3', winnerId, loserId, similarity: 0.85 });

    const first = await app.inject({ method: 'POST', url: '/consolidation/proposals/prop-3/reject', headers: AUTH });
    expect(first.statusCode).toBe(200);

    const race = await app.inject({ method: 'POST', url: '/consolidation/proposals/prop-3/reject', headers: AUTH });
    expect(race.statusCode).toBe(409);
    const parsed = JSON.parse(race.body) as { error: string; id: string };
    expect(parsed.error).toMatch(/already/i);
    expect(parsed.id).toBe('prop-3');
    expect(race.body).not.toContain('<html');
    expect(race.body).not.toContain('at ');  // no stack trace lines
  });

  // Pagination — PER_PAGE=25, in-memory slice over the already-fetched
  // ProposalRepo.list() rows (no new SQL). Preserves ?status= so paging
  // within e.g. "pending" doesn't jump to a different tab.
  describe('pagination — ?page= (PER_PAGE=25)', () => {
    function seedManyPending(count: number): void {
      const repo = new MemoryRepo(db);
      // Each proposal needs a DISTINCT (winner_id, loser_id) pair — pending
      // proposals are guarded by a unique index on that pair
      // (migrations/008-consolidation.sql), so reusing one winner/loser
      // across all rows collides on the second insert.
      for (let i = 0; i < count; i++) {
        const winnerId = insertMemory(repo, `winner text ${i}`, `h-page-winner-${i}`);
        const loserId = insertMemory(repo, `loser text ${i}`, `h-page-loser-${i}`);
        insertProposal(db, {
          id: `prop-page-${String(i).padStart(2, '0')}`,
          winnerId, loserId, similarity: 0.8,
          createdAt: Date.now() + i,
        });
      }
    }

    it('page 1 shows the first 25, page 2 shows the remaining rows — no overlap', async () => {
      seedManyPending(30);
      const page1 = await app.inject({ method: 'GET', url: '/dashboard/consolidation?status=pending&page=1', headers: AUTH });
      const page2 = await app.inject({ method: 'GET', url: '/dashboard/consolidation?status=pending&page=2', headers: AUTH });
      expect(page1.statusCode).toBe(200);
      expect(page2.statusCode).toBe(200);

      expect(page1.body).toContain('prop-page-00');
      expect(page1.body).toContain('prop-page-24');
      expect(page1.body).not.toContain('prop-page-25');

      expect(page2.body).toContain('prop-page-25');
      expect(page2.body).toContain('prop-page-29');
      expect(page2.body).not.toContain('prop-page-00');
    });

    it('renders the "page N/M — showing X–Y of Z" caption and a next link preserving ?status=', async () => {
      seedManyPending(30);
      const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation?status=pending&page=1', headers: AUTH });
      expect(res.body).toContain('page 1/2');
      expect(res.body).toContain('showing 1');
      expect(res.body).toContain('of 30');
      expect(res.body).toContain('href="/dashboard/consolidation?status=pending&page=2"');
      // prev is omitted (inert, not a link) on page 1.
      expect(res.body).not.toContain('href="/dashboard/consolidation?status=pending&page=0"');
    });

    it('next is omitted (inert) on the last page; prev links back', async () => {
      seedManyPending(30);
      const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation?status=pending&page=2', headers: AUTH });
      expect(res.body).toContain('page 2/2');
      expect(res.body).toContain('href="/dashboard/consolidation?status=pending&page=1"');
      expect(res.body).not.toContain('href="/dashboard/consolidation?status=pending&page=3"');
    });

    it('an out-of-range ?page= clamps to the last valid page instead of an empty table', async () => {
      seedManyPending(30);
      const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation?status=pending&page=999', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('prop-page-29');
      expect(res.body).toContain('page 2/2');
    });

    it('a non-numeric ?page= falls back to page 1', async () => {
      seedManyPending(30);
      const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation?status=pending&page=abc', headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('prop-page-00');
      expect(res.body).toContain('page 1/2');
    });
  });

  it('a missing memory shows "(memory not found)" instead of throwing', async () => {
    insertProposal(db, { id: 'prop-4', winnerId: 'ghost-winner', loserId: 'ghost-loser', similarity: 0.7 });
    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('(memory not found)');
  });

  // AC-12 (FEAT-456 SLICE-2): pending merge and contradiction proposals get
  // visually distinct kind badges, not just the same plain-text cell.
  it('renders a distinct kind badge class for merge vs contradiction proposals', async () => {
    const repo = new MemoryRepo(db);
    const mergeWinner = insertMemory(repo, 'merge winner text', 'h-badge-1');
    const mergeLoser = insertMemory(repo, 'merge loser text', 'h-badge-2');
    const contraWinner = insertMemory(repo, 'default port is now 8888', 'h-badge-3');
    const contraLoser = insertMemory(repo, 'default port is 7777', 'h-badge-4');
    insertProposal(db, { id: 'prop-badge-merge', winnerId: mergeWinner, loserId: mergeLoser, similarity: 0.9, kind: 'merge' });
    insertProposal(db, { id: 'prop-badge-contra', winnerId: contraWinner, loserId: contraLoser, similarity: 0.7, kind: 'contradiction' });

    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="kind-badge kind-merge"');
    expect(res.body).toContain('class="kind-badge kind-contradiction"');
  });
});

// The buttons never worked from a real browser before this: a plain HTML
// form can't send an Authorization header, the old /consolidation/...
// routes are Bearer-only, and the astramem_dash cookie is scoped
// Path=/dashboard so it wouldn't even attach to /consolidation/... anyway.
// These dashboard-scoped routes close that gap end to end.
describe('POST /dashboard/consolidation/proposals/:id/accept|reject — dashboard-scoped mutation routes', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN });
  });

  it('real browser flow: cookie-only accept actually resolves the proposal and 303s back to the list', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner browser accept', 'h-br-w1');
    const loserId = insertMemory(repo, 'loser browser accept', 'h-br-l1');
    insertProposal(db, { id: 'prop-browser-accept', winnerId, loserId, similarity: 0.9 });

    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-browser-accept/accept',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/dashboard/consolidation');
    expect(new ProposalRepo(db).get('prop-browser-accept')?.status).toBe('accepted');
  });

  it('real browser flow: cookie-only reject actually resolves the proposal and 303s back to the list', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner browser reject', 'h-br-w2');
    const loserId = insertMemory(repo, 'loser browser reject', 'h-br-l2');
    insertProposal(db, { id: 'prop-browser-reject', winnerId, loserId, similarity: 0.85 });

    const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
    const cookie = String(boot.headers['set-cookie']).split(';')[0]!;

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-browser-reject/reject',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/dashboard/consolidation');
    expect(new ProposalRepo(db).get('prop-browser-reject')?.status).toBe('rejected');
  });

  it('a not-found id 404s with a structured body instead of a raw crash', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/does-not-exist/accept',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toMatchObject({ error: 'not found', id: 'does-not-exist' });
  });

  it('Bearer also works directly on the dashboard-scoped route (not cookie-only)', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner bearer dash', 'h-br-w3');
    const loserId = insertMemory(repo, 'loser bearer dash', 'h-br-l3');
    insertProposal(db, { id: 'prop-bearer-dash', winnerId, loserId, similarity: 0.9 });

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-bearer-dash/accept',
      headers: AUTH,
    });
    expect(res.statusCode).toBe(303);
  });

  it('devNoAuth off: no cookie, no bearer => 401', async () => {
    insertProposal(db, { id: 'prop-dash-noauth', winnerId: 'w', loserId: 'l', similarity: 0.5 });
    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-dash-noauth/accept',
    });
    expect(res.statusCode).toBe(401);
  });
});

// CSRF hardening: with devNoAuth active, a urlencoded <form method="post"> is
// a CORS "simple request" (no preflight) and the Host header on a form POST
// is always the TARGET, not the calling page — so the loopback Host guard
// alone cannot stop a malicious page from firing credential-free POSTs at
// these mutating routes. See dashboard-auth.ts's checkDashboardAuth doc
// comment and src/server/lib/origin-guard.ts.
describe('devNoAuth CSRF hardening on the dashboard mutation routes', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    const config = { ...defaultConfig(), auth: { devNoAuth: true } };
    app = await buildApp({ db, token: TOKEN, config });
  });

  it('no credentials, loopback Host, no Origin header => works (the dashboard\'s own form posts carry no Origin)', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner devnoauth ok', 'h-dna-w1');
    const loserId = insertMemory(repo, 'loser devnoauth ok', 'h-dna-l1');
    insertProposal(db, { id: 'prop-devnoauth-ok', winnerId, loserId, similarity: 0.9 });

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-devnoauth-ok/accept',
      headers: { host: '127.0.0.1:7777' },
    });
    expect(res.statusCode).toBe(303);
  });

  it('Origin: https://evil.example.com => 403, and the proposal is left untouched', async () => {
    insertProposal(db, { id: 'prop-devnoauth-evil', winnerId: 'w', loserId: 'l', similarity: 0.5 });

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-devnoauth-evil/accept',
      headers: { host: '127.0.0.1:7777', origin: 'https://evil.example.com' },
    });
    expect(res.statusCode).toBe(403);
    expect(new ProposalRepo(db).get('prop-devnoauth-evil')?.status).toBe('pending');
  });

  it('Origin: http://127.0.0.1:7777 (loopback) => works', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner loopback origin', 'h-dna-w2');
    const loserId = insertMemory(repo, 'loser loopback origin', 'h-dna-l2');
    insertProposal(db, { id: 'prop-devnoauth-loopback-origin', winnerId, loserId, similarity: 0.9 });

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-devnoauth-loopback-origin/accept',
      headers: { host: '127.0.0.1:7777', origin: 'http://127.0.0.1:7777' },
    });
    expect(res.statusCode).toBe(303);
  });
});
