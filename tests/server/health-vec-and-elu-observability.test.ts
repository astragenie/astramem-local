/**
 * tests/server/health-vec-and-elu-observability.test.ts (2026-08-06)
 *
 * Forensics follow-up to #484 (2026-08-05 daemon-stability investigation).
 * Two measurements existed but died unread:
 *
 *  1. VecSearchWorkerHost's `searchTimeoutCount` / `fallbackCount` getters —
 *     since #484 a vec-search timeout FAILS the query's vec leg and hybrid
 *     search silently serves FTS-only; nothing surfaced how often that
 *     happens. /health now carries a `vec_search` block.
 *
 *  2. The scheduled "Event loop lag" doctor check computes p99/mean/max and
 *     then RESETS the monitor — the completed-window numbers survived only
 *     inside a prose message. The check now attaches them as
 *     `CheckResult.data`, and serve.ts persists them into
 *     `healthState.doctor.lastEventLoop` (surfaced via /health's existing
 *     doctor block).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { healthRoute } from '../../src/server/routes/health.js';
import { defaultConfig } from '../../src/config/config.js';
import { createHealthState, type HealthState } from '../../src/server/health-state.js';
import { __resetProviderHealthRegistryForTest } from '../../src/providers/llm/health-tracking.js';
import { checkEventLoopLag, MIN_WINDOW_AGE_MS } from '../../src/doctor/checks/event-loop-lag.js';
import type { EventLoopLagMonitor } from '../../src/server/event-loop-lag.js';

function baseState(): HealthState {
  const hs = createHealthState();
  hs.ready = true;
  hs.embed.ok = true;
  return hs;
}

describe('GET /health — vec_search offload counters', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    __resetProviderHealthRegistryForTest();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('surfaces search_timeouts and fallbacks when a vec host is registered', async () => {
    const hs = baseState();
    // Structural stand-in for VecSearchWorkerHost — same getter surface.
    hs.vecSearch = { searchTimeoutCount: 3, fallbackCount: 1 };
    app = Fastify({ logger: false });
    await app.register(healthRoute(defaultConfig(), db, hs));
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.vec_search).toEqual({ search_timeouts: 3, fallbacks: 1 });
  });

  it('reads live counter values, not a snapshot taken at registration', async () => {
    const hs = baseState();
    let timeouts = 0;
    hs.vecSearch = {
      get searchTimeoutCount() { return timeouts; },
      get fallbackCount() { return 0; },
    };
    app = Fastify({ logger: false });
    await app.register(healthRoute(defaultConfig(), db, hs));
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/health' })).json().vec_search.search_timeouts).toBe(0);
    timeouts = 7;
    expect((await app.inject({ method: 'GET', url: '/health' })).json().vec_search.search_timeouts).toBe(7);
  });

  it('omits the block entirely when no vec host is registered (mcp-stdio, :memory:, tests)', async () => {
    const hs = baseState();
    app = Fastify({ logger: false });
    await app.register(healthRoute(defaultConfig(), db, hs));
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body).not.toHaveProperty('vec_search');
  });
});

describe('GET /health — doctor.lastEventLoop persisted window', () => {
  let db: DB;
  let app: FastifyInstance;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    __resetProviderHealthRegistryForTest();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  it('surfaces the last completed doctor-cadence window on the wire', async () => {
    const hs = baseState();
    hs.doctor = {
      lastRunAt: 1_000,
      lastTier: 'frequent',
      lastFailCount: 0,
      lastInconclusiveCount: 0,
      lastFailNames: [],
      lastEventLoop: { p99Ms: 72, meanMs: 11, maxMs: 64_391, windowAgeMs: 900_000, measuredAt: 1_000 },
    };
    app = Fastify({ logger: false });
    await app.register(healthRoute(defaultConfig(), db, hs));
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.doctor.lastEventLoop).toEqual({
      p99Ms: 72, meanMs: 11, maxMs: 64_391, windowAgeMs: 900_000, measuredAt: 1_000,
    });
  });

  it('is null before the first scheduled run completes — not absent, not zeros', async () => {
    const hs = baseState();
    app = Fastify({ logger: false });
    await app.register(healthRoute(defaultConfig(), db, hs));
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.doctor.lastEventLoop).toBeNull();
  });
});

describe('checkEventLoopLag — attaches structured numbers as CheckResult.data', () => {
  function fakeMonitor(p99Ms: number, maxMs: number, windowAgeMs: number, now: number): EventLoopLagMonitor {
    return {
      snapshot: () => ({ p99Ms, meanMs: p99Ms / 2, maxMs, windowStartedAt: now - windowAgeMs }),
      reset: () => {},
      disable: () => {},
    } as unknown as EventLoopLagMonitor;
  }

  it('GREEN result carries the numbers the message renders', async () => {
    const res = await checkEventLoopLag(0, fakeMonitor(80, 400, MIN_WINDOW_AGE_MS * 10, Date.now())).run();
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ p99_ms: 80, mean_ms: 40, max_ms: 400 });
    expect(res.data!.window_age_ms).toBeGreaterThanOrEqual(MIN_WINDOW_AGE_MS * 10 - 1_000);
  });

  it('RED result carries the numbers too — the alarm case is exactly when history matters', async () => {
    const res = await checkEventLoopLag(0, fakeMonitor(2_000, 30_000, MIN_WINDOW_AGE_MS * 10, Date.now())).run();
    expect(res.ok).toBe(false);
    expect(res.data).toMatchObject({ p99_ms: 2_000, max_ms: 30_000 });
  });

  it('inconclusive cold-start result still carries partial numbers', async () => {
    const res = await checkEventLoopLag(0, fakeMonitor(50, 100, MIN_WINDOW_AGE_MS / 2, Date.now())).run();
    expect(res.inconclusive).toBe(true);
    expect(res.data).toMatchObject({ p99_ms: 50 });
  });
});
