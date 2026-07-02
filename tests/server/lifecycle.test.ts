import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
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

  it('downward promotion (team -> personal) -> 400', async () => {
    const id = insertMem(repo, 'lc-prom-2');
    await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' }, payload: { scope: 'team' },
    });
    const res = await app.inject({
      method: 'POST', url: `/memory/${id}/promote`,
      headers: { authorization: 'Bearer tok' }, payload: { scope: 'personal' },
    });
    expect(res.statusCode).toBe(400);
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
    expect(body.history.map(e => e.event_type)).toEqual(['promote_scope', 'invalidate']);
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
