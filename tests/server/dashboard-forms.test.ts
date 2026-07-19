import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { buildApp } from '../../src/server/app.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { ProposalRepo } from '../../src/consolidate/proposals.js';
import type { DB } from '../../src/storage/db.js';

const TOKEN = 'testtoken';

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
  opts: { id: string; winnerId: string; loserId: string; similarity: number },
): void {
  db.prepare(`
    INSERT INTO consolidation_proposals (id, kind, winner_id, loser_id, similarity, status, created_at, resolved_at)
    VALUES (?, 'merge', ?, ?, ?, 'pending', ?, NULL)
  `).run(opts.id, opts.winnerId, opts.loserId, opts.similarity, Date.now());
}

/**
 * FEAT-483 SLICE-5 — browser-shaped dashboard route e2e.
 *
 * Every mutating dashboard `<form method="post">` action, hit with the EXACT
 * shape a real browser sends on submit: `Content-Type:
 * application/x-www-form-urlencoded` and an empty body (these forms carry no
 * input fields — see dashboard-consolidation-html.ts's row forms) — NOT
 * `application/json`, which is what most of this test suite's other POSTs
 * use and which happens to hide this bug class.
 *
 * The incident (FEAT-483 backlog item 5): the dashboard's accept/reject
 * buttons 415'd (`FST_ERR_CTP_INVALID_MEDIA_TYPE`) from the day they shipped,
 * because Fastify has no built-in parser for
 * `application/x-www-form-urlencoded` and none was registered — a manual
 * click was the first thing to ever exercise the real content-type. The fix
 * (an `addContentTypeParser` for that media type in `src/server/app.ts`,
 * landed in PR #172 well before this slice) already covers this and is
 * exercised inline in `dashboard-consolidation-html.test.ts`. This file is
 * the FEAT-483-requested dedicated canary: one row per dashboard form
 * action, enumerated by hand from the route files (no dashboard route
 * currently derives a table the way `dashboard-api-html.ts`'s GET reference
 * does), so a FUTURE dashboard `<form method="post">` (promote/restore/etc.)
 * that forgets a body it can be sent without a parser doesn't fly under a
 * green suite unnoticed.
 *
 * Keep this list honest: `grep -rn '<form method="post"' src/server/routes/dashboard-*.ts`
 * currently returns exactly the two rows below (dashboard-consolidation-html.ts).
 * Add a row here whenever that grep grows.
 */
const DASHBOARD_FORM_ACTIONS = [
  { name: 'consolidation accept', action: 'accept' as const },
  { name: 'consolidation reject', action: 'reject' as const },
];

describe('dashboard forms — exact browser urlencoded POST (FEAT-483 SLICE-5)', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN });
  });

  it.each(DASHBOARD_FORM_ACTIONS)(
    '$name: real <form> POST (urlencoded, cookie-only, no Authorization header) succeeds — not 415',
    async ({ action }) => {
      const repo = new MemoryRepo(db);
      const id = `prop-form-${action}`;
      const winnerId = insertMemory(repo, `winner ${action}`, `h-form-${action}-w`);
      const loserId = insertMemory(repo, `loser ${action}`, `h-form-${action}-l`);
      insertProposal(db, { id, winnerId, loserId, similarity: 0.9 });

      // Bootstrap the session cookie exactly the way the dashboard's own nav
      // does — a real browser never carries an Authorization header, only
      // this cookie (a plain <form> can't set custom headers at all).
      const boot = await app.inject({ method: 'GET', url: '/dashboard?token=testtoken' });
      const cookie = String(boot.headers['set-cookie']).split(';')[0]!;

      const res = await app.inject({
        method: 'POST',
        url: `/dashboard/consolidation/proposals/${id}/${action}`,
        headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });

      // Prior to the fix this was a 415 (FST_ERR_CTP_INVALID_MEDIA_TYPE) —
      // the route handler never even ran. The success shape here is the
      // route's normal POST-redirect-GET 303, not a JSON 200.
      expect(res.statusCode).not.toBe(415);
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/dashboard/consolidation');

      const expectedStatus = action === 'accept' ? 'accepted' : 'rejected';
      expect(new ProposalRepo(db).get(id)?.status).toBe(expectedStatus);
    },
  );

  it('sanity: an unparsed urlencoded POST would 415 without the app.ts content-type parser (documents the bug this suite guards)', async () => {
    // Build a bare Fastify-less-parser app is out of scope here (app.ts always
    // registers the parser); this test instead pins the parser's presence by
    // asserting the same request shape that used to 415 now reaches the route
    // and gets a real business-logic response, never a raw 415 passthrough.
    const repo = new MemoryRepo(db);
    const winnerId = insertMemory(repo, 'winner sanity', 'h-sanity-w');
    const loserId = insertMemory(repo, 'loser sanity', 'h-sanity-l');
    insertProposal(db, { id: 'prop-sanity', winnerId, loserId, similarity: 0.9 });

    const res = await app.inject({
      method: 'POST',
      url: '/dashboard/consolidation/proposals/prop-sanity/accept',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(303);
  });
});
