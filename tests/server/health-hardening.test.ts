import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { createHealthState } from '../../src/server/health-state.js';
import { JobRepo } from '../../src/pipeline/job-repo.js';

const TOKEN = 'devtok';

describe('/health hardening fields (P1.3) — additive, wire-safe', () => {
  let db: DB;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('without healthState: legacy shape only (wire compat)', async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN });
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.version).toBeDefined();
    // U6 (#106): wire_versions_supported is now the domain@gen vocabulary
    // (repurposed from the legacy flat v0.0/v1.0 list) — still additive/
    // wire-safe, and contract_schema_version rides alongside it.
    expect(body.wire_versions_supported).toBeDefined();
    expect(new Set(body.wire_versions_supported)).toEqual(
      new Set(['atom@1', 'atom@2', 'retrieval@1', 'sync@1', 'capture@1']),
    );
    expect(body.contract_schema_version).toBe('1');
    expect(body.schema_version).toBeDefined();
    expect(body.security).toBeDefined();
    expect(body.usefulness).toBeDefined();
    expect(body.status).toBeUndefined();
    expect(body.queue).toBeUndefined();
  });

  it('with healthState: reports status, worker liveness, queue counts', async () => {
    db = openDb(':memory:');
    migrate(db);
    const hs = createHealthState();
    hs.embed.ok = true;
    hs.worker.lastTickAt = Date.now();
    const repo = new JobRepo(db);
    repo.enqueue('distill', {});
    repo.enqueue('distill', {});
    app = await buildApp({ db, token: TOKEN, healthState: hs });

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.ok).toBe(true); // reachable => ok stays true
    expect(body.status).toBe('ok');
    expect(typeof body.uptime_s).toBe('number');
    expect(body.embed.ok).toBe(true);
    expect(body.worker.alive).toBe(true);
    expect(body.queue.pending).toBe(2);
  });

  it('degraded embed → status degraded, ok still true', async () => {
    db = openDb(':memory:');
    migrate(db);
    const hs = createHealthState();
    hs.embed.ok = false;
    hs.embed.lastError = 'ollama: timeout';
    app = await buildApp({ db, token: TOKEN, healthState: hs });

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe('degraded');
    expect(body.embed.last_error).toBe('ollama: timeout');
  });

  it('stale worker tick → alive false', async () => {
    db = openDb(':memory:');
    migrate(db);
    const hs = createHealthState();
    hs.embed.ok = true;
    hs.worker.lastTickAt = Date.now() - 10 * 60_000; // 10 minutes ago
    app = await buildApp({ db, token: TOKEN, healthState: hs });

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.worker.alive).toBe(false);
    expect(body.worker.last_tick_ago_ms).toBeGreaterThan(9 * 60_000);
  });

  // FEAT-410 AC-2: /health's queue counts must come from the same shared
  // function as /dashboard's (queryJobStates in queries/dashboard.ts) — not
  // a second, independently-computed query.
  it('queue counts match queryJobStates(db) exactly (single source of truth)', async () => {
    db = openDb(':memory:');
    migrate(db);
    const hs = createHealthState();
    const repo = new JobRepo(db);
    repo.enqueue('distill', {});
    repo.enqueue('distill', {});
    repo.enqueue('reembed', {});
    app = await buildApp({ db, token: TOKEN, healthState: hs });

    const { queryJobStates } = await import('../../src/server/queries/dashboard.js');
    const expected: Record<string, number> = {};
    for (const row of queryJobStates(db)) expected[row.state] = row.count;

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.queue).toEqual(expected);
  });

  // FEAT-444 AC-2: memory_health detail block, cheap tier only.
  describe('memory_health block (FEAT-444 AC-2)', () => {
    it('present alongside status/embed when healthState + db are wired, every pre-existing field unchanged', async () => {
      db = openDb(':memory:');
      migrate(db);
      const hs = createHealthState();
      hs.embed.ok = true;
      app = await buildApp({ db, token: TOKEN, healthState: hs });

      const body = (await app.inject({ method: 'GET', url: '/health' })).json();
      // Pre-existing fields untouched (wire-compat).
      expect(body.ok).toBe(true);
      expect(body.version).toBeDefined();
      expect(body.status).toBe('ok');
      expect(body.embed.ok).toBe(true);
      expect(body.worker).toBeDefined();
      // Additive block.
      expect(body.memory_health).toBeDefined();
      expect(body.memory_health.activeCount).toBe(0);
      expect(body.memory_health.archivedCount).toBe(0);
      expect(body.memory_health.usefulness).toEqual({ served: 0, used: 0, coverageRate: null });
      expect(body.memory_health.corrections).toEqual({ corrected: 0, rate: null });
      expect(body.memory_health.poisonDistillSessions).toBe(0);
      // Cheap tier only — no byType/byScope/staleness breakdown on /health.
      expect(body.memory_health.counts).toBeNull();
      expect(body.memory_health.staleness).toBeNull();
    });

    it('reflects real counts when memories exist', async () => {
      db = openDb(':memory:');
      migrate(db);
      const { MemoryRepo } = await import('../../src/storage/memories.js');
      new MemoryRepo(db).insert({
        type: 'fact', text: 'a fact', normalized_text: 'a fact',
        repo: 'r1', project: null, branch: null, agent: null, session_id: null,
        hash: 'h-health-1', source_hash: null,
      });
      const hs = createHealthState();
      app = await buildApp({ db, token: TOKEN, healthState: hs });

      const body = (await app.inject({ method: 'GET', url: '/health' })).json();
      expect(body.memory_health.activeCount).toBe(1);
    });

    it('absent without healthState (legacy shape only — matches queue/pending_proposals precedent)', async () => {
      db = openDb(':memory:');
      migrate(db);
      app = await buildApp({ db, token: TOKEN });

      const body = (await app.inject({ method: 'GET', url: '/health' })).json();
      expect(body.memory_health).toBeUndefined();
    });
  });
});

describe('Fastify hardening (P1.6)', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN });
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('accepts bodies over the old 1MiB default (long transcripts)', async () => {
    // 2 MiB of content — would 413 under Fastify's default bodyLimit.
    const big = 'x'.repeat(2 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { session_id: 'big-session', source: 'claude-code', content: big },
    });
    expect(res.statusCode).not.toBe(413);
  });

  it('rejects bodies over 10MiB with 413', async () => {
    const huge = 'x'.repeat(11 * 1024 * 1024);
    const res = await app.inject({
      method: 'POST',
      url: '/ingest/transcript',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      payload: { session_id: 's', source: 'claude-code', content: huge },
    });
    expect(res.statusCode).toBe(413);
  });

  it('unhandled route errors return sanitized {ok:false} 500, no stack on the wire', async () => {
    app.get('/boom', () => {
      throw new Error('secret internal detail');
    });
    const res = await app.inject({
      method: 'GET',
      url: '/boom',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('internal');
    expect(body.error.message).toBe('internal error');
    expect(res.payload).not.toContain('secret internal detail');
  });
});

// Wave 0 Item 3 — boot-readiness gate. `healthState.ready` defaults to
// `true` (see health-state.ts) so every OTHER test in this file — which
// never touches the field — is unaffected; these tests are the only ones
// that exercise the `false` state deliberately, at the buildApp() level
// (deterministic — no real daemon spawn / timing needed) rather than via a
// real serve.ts boot, which is the authoritative test for the mechanism
// serve.ts relies on.
describe('boot-readiness gate (Wave 0 Item 3) — healthState.ready === false', () => {
  let db: DB;
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('/health and /version answer normally while not ready; every other route 503s', async () => {
    db = openDb(':memory:');
    migrate(db);
    const hs = createHealthState();
    hs.ready = false;
    app = await buildApp({ db, token: TOKEN, healthState: hs });

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json().status).toBe('starting');

    // /health/full is NOT in the public loopback exemption (unlike /health
    // and /version — see app.ts's auth hook) even outside this gate, so it
    // needs a bearer regardless of readiness; what this asserts is that the
    // readiness gate itself doesn't ALSO block it once authed.
    const full = await app.inject({
      method: 'GET',
      url: '/health/full',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(full.statusCode).toBe(200);

    const version = await app.inject({ method: 'GET', url: '/version' });
    expect(version.statusCode).toBe(200);

    // Authed route — even WITH a valid bearer token, must 503 while not ready.
    const search = await app.inject({
      method: 'GET',
      url: '/search?q=x',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(search.statusCode).toBe(503);
    const body = search.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('starting');

    // Unauthenticated request to an authed route also 503s (the readiness
    // gate runs BEFORE the auth hook) rather than 401ing first.
    const searchNoAuth = await app.inject({ method: 'GET', url: '/search?q=x' });
    expect(searchNoAuth.statusCode).toBe(503);
  });

  it('flipping ready back to true unblocks every route immediately (no restart needed)', async () => {
    db = openDb(':memory:');
    migrate(db);
    const hs = createHealthState();
    hs.ready = false;
    hs.embed.ok = true;
    app = await buildApp({ db, token: TOKEN, healthState: hs });

    const before = await app.inject({
      method: 'GET',
      url: '/search?q=x',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(before.statusCode).toBe(503);

    hs.ready = true;
    const after = await app.inject({
      method: 'GET',
      url: '/search?q=x',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(after.statusCode).not.toBe(503);

    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.json().status).toBe('ok'); // ready + embed.ok=true
  });

  it('does not gate anything when healthState is absent (bare test apps unaffected)', async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: TOKEN }); // no healthState at all

    const search = await app.inject({
      method: 'GET',
      url: '/search?q=x',
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(search.statusCode).not.toBe(503);
  });
});
