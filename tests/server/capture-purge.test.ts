/**
 * FEAT-467 purge-batch REST surface (ADR-013 Decision 4 gate):
 *   POST /capture/purge { capture_source, restore_window_days? }
 *   POST /capture/purge/:batchId/restore
 *   POST /capture/purge/:batchId/finalize
 *
 * Mirrors tests/server/lifecycle.test.ts's shape for the existing lifecycle
 * verbs (happy path, 404, 409, 401) plus an end-to-end AC-4 exercise of both
 * the restore path and the finalize path, and an AC-6 history-surface check.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';
import { defaultConfig } from '../../src/config/config.js';

function insertMem(
  repo: MemoryRepo,
  hash: string,
  extra: Partial<Parameters<MemoryRepo['insert']>[0]> = {},
): string {
  return repo.insert({
    type: 'fact', text: 'capture-purge test', normalized_text: 'capture-purge test',
    repo: 'r1', project: null, branch: null, agent: null, session_id: null,
    hash, source_hash: null,
    ...extra,
  });
}

describe('POST /capture/purge', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('happy path — opens a batch, soft-invalidates every matching atom, leaves others untouched', async () => {
    const auto1 = insertMem(repo, 'cp-auto-1', { capture_source: 'auto_capture' });
    const auto2 = insertMem(repo, 'cp-auto-2', { capture_source: 'auto_capture' });
    const manual = insertMem(repo, 'cp-manual-1', { capture_source: null });

    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { batch_id: string; count: number };
    expect(body.count).toBe(2);
    expect(typeof body.batch_id).toBe('string');

    expect(repo.get(auto1)?.valid_to).not.toBeNull();
    expect(repo.get(auto2)?.valid_to).not.toBeNull();
    expect(repo.get(manual)?.valid_to).toBeNull(); // untouched — scoped by capture_source
  });

  it('no matching atoms — still 200, count 0', async () => {
    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: 0 });
  });

  it('missing capture_source -> 400', async () => {
    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('requires bearer auth', async () => {
    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      payload: { capture_source: 'auto_capture' },
    });
    expect(res.statusCode).toBe(401);
  });

  // AC-5: same route, capture_source is a plain parameter — 'proxy' works identically.
  it('capture_source "proxy" is scoped identically, no branching', async () => {
    const proxyAtom = insertMem(repo, 'cp-proxy-1', { capture_source: 'proxy' });
    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'proxy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: 1 });
    expect(repo.get(proxyAtom)?.valid_to).not.toBeNull();
  });

  // AC-6: batch id + restore-deadline are visible directly on the purge
  // event's own payload via the existing history surface — not just a bare
  // state change indistinguishable from a manual invalidate(), and not
  // something the caller has to separately look up in purge_batches.
  it('the purge event is visible via GET /memory/:id/history with batch id + restore-deadline on the payload itself', async () => {
    const id = insertMem(repo, 'cp-history-1', { capture_source: 'auto_capture' });
    const purgeRes = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });
    const { batch_id: batchId } = purgeRes.json() as { batch_id: string };

    const histRes = await app.inject({
      method: 'GET', url: `/memory/${id}/history`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(histRes.statusCode).toBe(200);
    const body = histRes.json() as { history: Array<{ event_type: string; payload_json: string }> };
    expect(body.history.map(e => e.event_type)).toEqual(['purge']);
    const payload = JSON.parse(body.history[0]!.payload_json);
    expect(payload.batch_id).toBe(batchId);
    expect(payload.capture_source).toBe('auto_capture');
    expect(typeof payload.restore_deadline_at).toBe('number');
    expect(payload.restore_deadline_at).toBeGreaterThan(Date.now());

    // Matches the purge_batches row exactly — this is a read-convenience
    // duplication fixed at purge time, not a value that can drift.
    const batchRow = db.prepare('SELECT restore_deadline_at FROM purge_batches WHERE batch_id = ?').get(batchId) as {
      restore_deadline_at: number;
    };
    expect(payload.restore_deadline_at).toBe(batchRow.restore_deadline_at);
  });

  it('why_memory (GET /memory/:id/why) also surfaces the purge event in history', async () => {
    const id = insertMem(repo, 'cp-why-1', { capture_source: 'auto_capture' });
    await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });

    const res = await app.inject({
      method: 'GET', url: `/memory/${id}/why`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: Array<{ event_type: string }> };
    expect(body.history.map(e => e.event_type)).toEqual(['purge']);
  });

  it('a custom restore_window_days overrides the config default', async () => {
    insertMem(repo, 'cp-custom-window', { capture_source: 'auto_capture' });
    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture', restore_window_days: 1 },
    });
    const { batch_id: batchId } = res.json() as { batch_id: string };
    const batchRow = db.prepare('SELECT requested_at, restore_deadline_at FROM purge_batches WHERE batch_id = ?').get(batchId) as {
      requested_at: number; restore_deadline_at: number;
    };
    const deltaDays = (batchRow.restore_deadline_at - batchRow.requested_at) / 86_400_000;
    expect(deltaDays).toBeCloseTo(1, 5);
  });
});

describe('POST /capture/purge/:batchId/restore', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  async function openBatch(atomHash: string): Promise<{ id: string; batchId: string }> {
    const id = insertMem(repo, atomHash, { capture_source: 'auto_capture' });
    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });
    const { batch_id: batchId } = res.json() as { batch_id: string };
    return { id, batchId };
  }

  it('happy path — 200 { restored }, atom becomes current again, fully searchable', async () => {
    const { id, batchId } = await openBatch('cp-restore-1');
    expect(repo.get(id)?.valid_to).not.toBeNull();

    const res = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/restore`,
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ restored: 1 });
    expect(repo.get(id)?.valid_to).toBeNull();
  });

  it('unknown batch id -> 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/capture/purge/nope/restore',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('already-restored batch -> 409', async () => {
    const { batchId } = await openBatch('cp-restore-conflict');
    await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    const res = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('requires bearer auth', async () => {
    const { batchId } = await openBatch('cp-restore-unauth');
    const res = await app.inject({ method: 'POST', url: `/capture/purge/${batchId}/restore` });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /capture/purge/:batchId/finalize', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok' });
  });

  async function openBatch(atomHash: string): Promise<{ id: string; batchId: string }> {
    const id = insertMem(repo, atomHash, { capture_source: 'auto_capture' });
    const res = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });
    const { batch_id: batchId } = res.json() as { batch_id: string };
    return { id, batchId };
  }

  // AC-3 / AC-4: finalize hard-erases — permanently gone, verified end to end.
  it('happy path — 200 { erased }, atom is hard-erased (row + FTS gone)', async () => {
    const { id, batchId } = await openBatch('cp-finalize-1');

    const res = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/finalize`,
      headers: { authorization: 'Bearer tok' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ erased: 1 });
    expect(repo.get(id)).toBeNull();

    // Once finalized, restore must reject — the content is truly gone.
    const restoreRes = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(restoreRes.statusCode).toBe(409);
  });

  it('unknown batch id -> 404', async () => {
    const res = await app.inject({
      method: 'POST', url: '/capture/purge/nope/finalize',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('already-finalized batch -> 409', async () => {
    const { batchId } = await openBatch('cp-finalize-conflict');
    await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/finalize`,
      headers: { authorization: 'Bearer tok' },
    });
    const res = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/finalize`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('requires bearer auth', async () => {
    const { batchId } = await openBatch('cp-finalize-unauth');
    const res = await app.inject({ method: 'POST', url: `/capture/purge/${batchId}/finalize` });
    expect(res.statusCode).toBe(401);
  });
});

// AC-4: both outcomes verified end to end, sharing one opened batch each time.
describe('FEAT-467 AC-4 — purge/restore and purge/finalize both verified end to end', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok', config: defaultConfig() });
  });

  it('purge -> same-window restore -> fully searchable again', async () => {
    const id = insertMem(repo, 'ac4-restore', {
      capture_source: 'auto_capture',
      text: 'a uniquely findable purge-ac4-restore phrase',
      normalized_text: 'a uniquely findable purge-ac4-restore phrase',
    });

    const before = await app.inject({
      method: 'GET', url: '/search?q=uniquely+findable+purge-ac4-restore+phrase',
      headers: { authorization: 'Bearer tok' },
    });
    expect((before.json() as { hits: Array<{ id: string }> }).hits.map(h => h.id)).toContain(id);

    const purgeRes = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });
    const { batch_id: batchId } = purgeRes.json() as { batch_id: string };

    const duringPurge = await app.inject({
      method: 'GET', url: '/search?q=uniquely+findable+purge-ac4-restore+phrase',
      headers: { authorization: 'Bearer tok' },
    });
    expect((duringPurge.json() as { hits: Array<{ id: string }> }).hits.map(h => h.id)).not.toContain(id);

    const restoreRes = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(restoreRes.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET', url: '/search?q=uniquely+findable+purge-ac4-restore+phrase',
      headers: { authorization: 'Bearer tok' },
    });
    expect((after.json() as { hits: Array<{ id: string }> }).hits.map(h => h.id)).toContain(id);
  });

  it('purge -> finalize (simulated window expiry) -> permanently gone, incl. vector + FTS', async () => {
    const id = insertMem(repo, 'ac4-finalize', {
      capture_source: 'auto_capture',
      text: 'a uniquely findable purge-ac4-finalize phrase',
      normalized_text: 'a uniquely findable purge-ac4-finalize phrase',
    });

    const purgeRes = await app.inject({
      method: 'POST', url: '/capture/purge',
      headers: { authorization: 'Bearer tok' },
      payload: { capture_source: 'auto_capture' },
    });
    const { batch_id: batchId } = purgeRes.json() as { batch_id: string };

    // Simulate the restore window having already elapsed (a scheduled-sweep
    // scenario) by backdating the batch's deadline directly, rather than
    // racing real-clock precision with restore_window_days=0.
    db.prepare('UPDATE purge_batches SET restore_deadline_at = ? WHERE batch_id = ?').run(Date.now() - 1000, batchId);

    // A restore attempt after the (simulated-expired) window is a conflict.
    const staleRestore = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/restore`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(staleRestore.statusCode).toBe(409);

    const finalizeRes = await app.inject({
      method: 'POST', url: `/capture/purge/${batchId}/finalize`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(finalizeRes.statusCode).toBe(200);
    expect(finalizeRes.json()).toEqual({ erased: 1 });

    expect(repo.get(id)).toBeNull();
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    expect(row).toBeUndefined();
    const ftsRow = db.prepare(`SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'finalize'`).all();
    expect(ftsRow.length).toBe(0);

    const after = await app.inject({
      method: 'GET', url: '/search?q=uniquely+findable+purge-ac4-finalize+phrase',
      headers: { authorization: 'Bearer tok' },
    });
    expect((after.json() as { hits: Array<{ id: string }> }).hits.map(h => h.id)).not.toContain(id);
  });
});
