import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { buildApp } from '../../src/server/app.js';

function insertMem(repo: MemoryRepo, hash: string, extra: Partial<Parameters<MemoryRepo['insert']>[0]> = {}): string {
  return repo.insert({
    type: 'fact', text: 'lifecycle test', normalized_text: 'lifecycle test',
    repo: 'r1', project: null, branch: null, agent: null, session_id: null,
    hash, source_hash: null,
    ...extra,
  });
}

describe('POST /memory/:id/invalidate', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('happy path — 200 { ok: true }, memory becomes invalid', async () => {
    const id = insertMem(repo, 'lc-inv-1');
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/invalidate`,
      headers: { authorization: 'Bearer tok' },
      payload: { reason: 'no longer accurate' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(repo.get(id)?.valid_to).not.toBeNull();
  });

  it('reason is optional', async () => {
    const id = insertMem(repo, 'lc-inv-2');
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/invalidate`,
      headers: { authorization: 'Bearer tok' },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
  });

  it('unknown id -> 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/memory/nope/invalidate',
      headers: { authorization: 'Bearer tok' },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });

  it('already-invalid memory -> 409', async () => {
    const id = insertMem(repo, 'lc-inv-3');
    await app.inject({
      method: 'POST', url: `/memory/${id}/invalidate`,
      headers: { authorization: 'Bearer tok' }, payload: {},
    });
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/invalidate`,
      headers: { authorization: 'Bearer tok' }, payload: {},
    });
    expect(res.statusCode).toBe(409);
  });

  it('requires bearer auth', async () => {
    const id = insertMem(repo, 'lc-inv-4');
    const res = await app.inject({ method: 'POST', url: `/memory/${id}/invalidate`, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /memory/:id/supersede', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('happy path — old invalidated + superseded_by set, new stays valid', async () => {
    const oldId = insertMem(repo, 'lc-sup-old-1');
    const newId = insertMem(repo, 'lc-sup-new-1');

    const res = await app.inject({
      method: 'POST', url: `/memory/${oldId}/supersede`,
      headers: { authorization: 'Bearer tok' },
      payload: { new_id: newId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const oldMem = repo.get(oldId);
    expect(oldMem?.valid_to).not.toBeNull();
    expect(oldMem?.superseded_by).toBe(newId);
    expect(repo.get(newId)?.valid_to).toBeNull();
  });

  it('unknown old id -> 404', async () => {
    const newId = insertMem(repo, 'lc-sup-new-2');
    const res = await app.inject({
      method: 'POST', url: '/memory/nope/supersede',
      headers: { authorization: 'Bearer tok' },
      payload: { new_id: newId },
    });
    expect(res.statusCode).toBe(404);
  });

  it('unknown new_id -> 404', async () => {
    const oldId = insertMem(repo, 'lc-sup-old-3');
    const res = await app.inject({
      method: 'POST', url: `/memory/${oldId}/supersede`,
      headers: { authorization: 'Bearer tok' },
      payload: { new_id: 'nope' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('new_id already invalid -> 409', async () => {
    const oldId = insertMem(repo, 'lc-sup-old-4');
    const newId = insertMem(repo, 'lc-sup-new-4');
    await app.inject({
      method: 'POST', url: `/memory/${newId}/invalidate`,
      headers: { authorization: 'Bearer tok' }, payload: {},
    });
    const res = await app.inject({
      method: 'POST', url: `/memory/${oldId}/supersede`,
      headers: { authorization: 'Bearer tok' },
      payload: { new_id: newId },
    });
    expect(res.statusCode).toBe(409);
  });

  it('missing new_id -> 400', async () => {
    const oldId = insertMem(repo, 'lc-sup-old-5');
    const res = await app.inject({
      method: 'POST', url: `/memory/${oldId}/supersede`,
      headers: { authorization: 'Bearer tok' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /memory/:id/restore', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('happy path — 200 { ok: true }, archived memory becomes current again', async () => {
    const id = insertMem(repo, 'lc-res-1');
    events.archive(id, 'ttl-policy');

    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const mem = repo.get(id);
    expect(mem?.valid_to).toBeNull();
    expect(mem?.archived).toBe(false);
  });

  it('unknown id -> 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/memory/nope/restore',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('never-archived memory -> 409 (mirrors invalidate\'s already-invalid 409)', async () => {
    const id = insertMem(repo, 'lc-res-2');
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('requires bearer auth', async () => {
    const id = insertMem(repo, 'lc-res-3');
    events.archive(id, 'ttl-policy');
    const res = await app.inject({ method: 'POST', url: `/memory/${id}/restore` });
    expect(res.statusCode).toBe(401);
  });

  it('restore event is recorded in memory_events, visible via GET /memory/:id/history', async () => {
    const id = insertMem(repo, 'lc-res-4');
    events.archive(id, 'ttl-policy');
    await app.inject({
      method: 'POST', url: `/memory/${id}/restore`,
      headers: { authorization: 'Bearer tok' },
    });

    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/history`,
      headers: { authorization: 'Bearer tok' },
    });
    const body = res.json() as { history: Array<{ event_type: string }> };
    expect(body.history.map(e => e.event_type)).toEqual(['archive', 'restore']);
  });

  it('reappears in current-snapshot search after restore', async () => {
    const id = insertMem(repo, 'lc-res-5', {
      text: 'a uniquely findable restore-route phrase',
      normalized_text: 'a uniquely findable restore-route phrase',
    });
    events.archive(id, 'ttl-policy');

    const before = await app.inject({
      method: 'GET', url: '/search?q=uniquely+findable+restore-route+phrase',
      headers: { authorization: 'Bearer tok' },
    });
    expect((before.json() as { hits: Array<{ id: string }> }).hits.map(h => h.id)).not.toContain(id);

    const restoreRes = await app.inject({
      method: 'POST', url: `/memory/${id}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(restoreRes.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: '/search?q=uniquely+findable+restore-route+phrase',
      headers: { authorization: 'Bearer tok' },
    });
    expect((after.json() as { hits: Array<{ id: string }> }).hits.map(h => h.id)).toContain(id);
  });
});

describe('POST /memory/:id/promote', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('upward promotion (personal -> team) -> 200', async () => {
    const id = insertMem(repo, 'lc-prom-1');
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' },
      payload: { scope: 'team' },
    });
    expect(res.statusCode).toBe(200);
    expect(repo.get(id)?.scope).toBe('team');
  });

  // FEAT-435: a downward promotion is a valid id whose current state makes
  // the transition inapplicable — the same error class as "already invalid"
  // (invalidate) or "never archived" (restore), so it's a 409, not a 400.
  // 400 is reserved for malformed/invalid request bodies only.
  // Also exercises the one-release 'personal' alias (U7-local
  // astramem-local#110): the body normalizes 'personal' -> 'private' before
  // reaching promoteScope(), which is still rank 0 — a downward request from
  // 'team', so this must still 409 exactly as it did pre-rename.
  it('downward promotion (team -> personal, via the alias) -> 409', async () => {
    const id = insertMem(repo, 'lc-prom-2');
    await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' }, payload: { scope: 'team' },
    });
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' }, payload: { scope: 'personal' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ id });
  });

  it('invalid scope literal -> 400', async () => {
    const id = insertMem(repo, 'lc-prom-3');
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' },
      payload: { scope: 'galaxy' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('unknown id -> 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/memory/nope/promote',
      headers: { authorization: 'Bearer tok' },
      payload: { scope: 'team' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /memory/:id/history', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('returns the ordered event list after lifecycle ops', async () => {
    const id = insertMem(repo, 'lc-hist-1');
    await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' }, payload: { scope: 'team' },
    });
    await app.inject({
      method: 'POST', url: `/memory/${id}/invalidate`,
      headers: { authorization: 'Bearer tok' }, payload: { reason: 'done' },
    });

    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/history`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { id: string; history: Array<{ event_type: string }> };
    expect(body.id).toBe(id);
    // invalidate() also appends a 'usefulness' memory_corrected event (ADR-010) in the same tx.
    expect(body.history.map(e => e.event_type)).toEqual(['promote_scope', 'invalidate', 'usefulness']);
  });

  it('memory with no lifecycle events returns an empty history array', async () => {
    const id = insertMem(repo, 'lc-hist-2');
    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/history`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().history).toEqual([]);
  });

  it('unknown id -> 404', async () => {
    const res = await app.inject({
      method: 'GET', url: '/memory/nope/history',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('why_memory history is populated after lifecycle events (KF-A follow-up)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('GET /memory/:id/why includes non-empty history after a promote', async () => {
    const id = insertMem(repo, 'lc-why-1');
    await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' }, payload: { scope: 'team' },
    });

    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: Array<{ event_type: string }> };
    expect(body.history).toHaveLength(1);
    expect(body.history[0]?.event_type).toBe('promote_scope');
  });

  it('GET /memory/:id/why history is still [] when no lifecycle events happened', async () => {
    const id = insertMem(repo, 'lc-why-2');
    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.json().history).toEqual([]);
  });
});

// FEAT-435: lock the 404/409/401/400 matrix uniform across every lifecycle
// verb (invalidate / supersede / promote / restore) so a future 5th verb
// that diverges from mapLifecycleError fails CI instead of shipping quietly.
describe('lifecycle error-status conformance (FEAT-435)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let events: MemoryEventRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    events = new MemoryEventRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  const auth = { authorization: 'Bearer tok' };
  const UNKNOWN_ID = 'conf-nope';

  // Each verb's not-found/conflict/bad-body/unauthorized request, built
  // lazily so repo/events/app (bound in beforeEach) are always fresh.
  function getCase(verb: 'invalidate' | 'supersede' | 'promote' | 'restore') {
    switch (verb) {
      case 'invalidate':
        return {
          notFound: () => app.inject({
            method: 'POST', url: `/memory/${UNKNOWN_ID}/invalidate`, headers: auth, payload: {},
          }),
          conflict: () => {
            const id = insertMem(repo, 'conf-inv-conflict');
            events.invalidate(id);
            return app.inject({ method: 'POST', url: `/memory/${id}/invalidate`, headers: auth, payload: {} })
              .then(res => ({ res, id }));
          },
          badBody: () => {
            const id = insertMem(repo, 'conf-inv-badbody');
            return app.inject({
              method: 'POST', url: `/memory/${id}/invalidate`, headers: auth,
              payload: { reason: 123 },
            });
          },
          unauthorized: () => {
            const id = insertMem(repo, 'conf-inv-unauth');
            return app.inject({ method: 'POST', url: `/memory/${id}/invalidate`, payload: {} });
          },
        };
      case 'supersede':
        return {
          notFound: () => {
            const newId = insertMem(repo, 'conf-sup-notfound-new');
            return app.inject({
              method: 'POST', url: `/memory/${UNKNOWN_ID}/supersede`, headers: auth,
              payload: { new_id: newId },
            });
          },
          conflict: () => {
            const oldId = insertMem(repo, 'conf-sup-conflict-old');
            const newId = insertMem(repo, 'conf-sup-conflict-new');
            events.invalidate(newId);
            return app.inject({
              method: 'POST', url: `/memory/${oldId}/supersede`, headers: auth,
              payload: { new_id: newId },
            }).then(res => ({ res, id: oldId }));
          },
          badBody: () => {
            const id = insertMem(repo, 'conf-sup-badbody');
            return app.inject({ method: 'POST', url: `/memory/${id}/supersede`, headers: auth, payload: {} });
          },
          unauthorized: () => {
            const id = insertMem(repo, 'conf-sup-unauth');
            return app.inject({ method: 'POST', url: `/memory/${id}/supersede`, payload: { new_id: id } });
          },
        };
      case 'promote':
        return {
          notFound: () => app.inject({
            method: 'POST', url: `/memory/${UNKNOWN_ID}/promote`, headers: auth,
            payload: { scope: 'team' },
          }),
          conflict: () => {
            const id = insertMem(repo, 'conf-prom-conflict');
            events.promoteScope(id, 'team');
            return app.inject({
              method: 'POST', url: `/memory/${id}/promote`, headers: auth,
              payload: { scope: 'personal' },
            }).then(res => ({ res, id }));
          },
          badBody: () => {
            const id = insertMem(repo, 'conf-prom-badbody');
            return app.inject({
              method: 'POST', url: `/memory/${id}/promote`, headers: auth,
              payload: { scope: 'galaxy' },
            });
          },
          unauthorized: () => {
            const id = insertMem(repo, 'conf-prom-unauth');
            return app.inject({ method: 'POST', url: `/memory/${id}/promote`, payload: { scope: 'team' } });
          },
        };
      case 'restore':
        return {
          notFound: () => app.inject({ method: 'POST', url: `/memory/${UNKNOWN_ID}/restore`, headers: auth }),
          conflict: () => {
            const id = insertMem(repo, 'conf-res-conflict'); // never archived
            return app.inject({ method: 'POST', url: `/memory/${id}/restore`, headers: auth })
              .then(res => ({ res, id }));
          },
          badBody: null, // restore takes no body -> no malformed-body case
          unauthorized: () => {
            const id = insertMem(repo, 'conf-res-unauth');
            return app.inject({ method: 'POST', url: `/memory/${id}/restore` });
          },
        };
    }
  }

  const verbs = ['invalidate', 'supersede', 'promote', 'restore'] as const;

  it.each(verbs)('%s: nonexistent memory id -> 404 { error: "not found", id }', async (verb) => {
    const res = await getCase(verb).notFound();
    expect(res.statusCode).toBe(404);
    const body = res.json() as { error: string; id: string };
    expect(body.error).toBe('not found');
    expect(body.id).toBe(UNKNOWN_ID);
  });

  it.each(verbs)('%s: valid id, operation not applicable -> 409 { error, id }', async (verb) => {
    const { res, id } = await getCase(verb).conflict();
    expect(res.statusCode).toBe(409);
    const body = res.json() as { error: string; id: string };
    expect(typeof body.error).toBe('string');
    expect(body.error.length).toBeGreaterThan(0);
    expect(body.id).toBe(id);
  });

  it.each(verbs)('%s: missing/invalid Bearer -> 401', async (verb) => {
    const res = await getCase(verb).unauthorized();
    expect(res.statusCode).toBe(401);
  });

  it.each(verbs.filter(v => getCase(v).badBody !== null))('%s: malformed body -> 400', async (verb) => {
    const res = await getCase(verb).badBody!();
    expect(res.statusCode).toBe(400);
  });
});
