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
    expect(body.wire_versions_supported).toBeDefined();
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
