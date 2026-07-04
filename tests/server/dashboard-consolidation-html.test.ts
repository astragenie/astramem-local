import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { MemoryRepo } from '../../src/storage/memories.js';
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
  it('row forms target the existing accept/reject endpoints verbatim, and a subsequent GET reflects the new status', async () => {
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner text', 'h-w2');
    const loserId = insertMemory(repo, 'loser text', 'h-l2');
    insertProposal(db, { id: 'prop-2', winnerId, loserId, similarity: 0.8 });

    const before = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(before.body).toContain('action="/consolidation/proposals/prop-2/accept"');
    expect(before.body).toContain('action="/consolidation/proposals/prop-2/reject"');
    expect(before.body).toContain('Consolidation — pending: 1');

    const accept = await app.inject({
      method: 'POST',
      url: '/consolidation/proposals/prop-2/accept',
      headers: AUTH,
    });
    expect(accept.statusCode).toBe(200);

    const after = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(after.body).not.toContain('prop-2');
    expect(after.body.toLowerCase()).toContain('no pending proposals');
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

  it('a missing memory shows "(memory not found)" instead of throwing', async () => {
    insertProposal(db, { id: 'prop-4', winnerId: 'ghost-winner', loserId: 'ghost-loser', similarity: 0.7 });
    const res = await app.inject({ method: 'GET', url: '/dashboard/consolidation', headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('(memory not found)');
  });
});
