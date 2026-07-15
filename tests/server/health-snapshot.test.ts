/**
 * tests/server/health-snapshot.test.ts (stabilization plan P1.3)
 *
 * GET /health (liveness, watchdog target) must read the pre-computed
 * healthState.dbSnapshot when present — zero per-request SQL — and surface
 * its staleness as snapshot_age_ms. GET /health/full always recomputes
 * fresh. Callers without a snapshot (bare tests, non-daemon contexts) keep
 * the legacy live-compute path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { healthRoute, computeHealthDbSnapshot } from '../../src/server/routes/health.js';
import { createHealthState, type HealthState } from '../../src/server/health-state.js';
import { defaultConfig } from '../../src/config/config.js';

describe('/health db snapshot (P1.3)', () => {
  let db: DB;
  let app: FastifyInstance;
  let healthState: HealthState;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    healthState = createHealthState();
  });
  afterEach(async () => {
    await app.close();
    db.close();
    vi.restoreAllMocks();
  });

  async function buildApp(): Promise<void> {
    app = Fastify({ logger: false });
    await app.register(healthRoute(defaultConfig(), db, healthState));
    await app.ready();
  }

  it('prefers the snapshot and reports its age — no live queue recompute', async () => {
    healthState.dbSnapshot = {
      computedAt: Date.now() - 12_000,
      queue: { completed: 41 },
      pending_proposals: 7,
      memory_health: { generatedAt: 1, activeCount: 3 },
      disk_free_bytes: 123_456,
    };
    await buildApp();

    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(res.statusCode).toBe(200);
    // Values come from the snapshot verbatim (a live compute of this empty
    // DB would give completed:0 / pending:0).
    expect(body.queue).toEqual({ completed: 41 });
    expect(body.pending_proposals).toBe(7);
    expect(body.disk_free_bytes).toBe(123_456);
    expect(body.snapshot_age_ms).toBeGreaterThanOrEqual(12_000);
  });

  it('falls back to live compute when no snapshot is present (legacy path, no snapshot_age_ms)', async () => {
    await buildApp();
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.queue).toEqual({});
    expect(body.pending_proposals).toBe(0);
    expect(body.snapshot_age_ms).toBeUndefined();
  });

  it('/health/full always computes fresh even when a (stale) snapshot exists', async () => {
    healthState.dbSnapshot = {
      computedAt: Date.now() - 60_000,
      queue: { completed: 999 },
      pending_proposals: 999,
      memory_health: {},
      disk_free_bytes: null,
    };
    await buildApp();

    const body = (await app.inject({ method: 'GET', url: '/health/full' })).json();
    expect(body.queue).toEqual({}); // fresh read of the empty DB, not 999
    expect(body.pending_proposals).toBe(0);
    expect(body.snapshot_age_ms).toBeUndefined();
  });

  it('computeHealthDbSnapshot returns the full block shape and never throws on a bare DB', () => {
    const snap = computeHealthDbSnapshot(db);
    expect(snap.computedAt).toBeGreaterThan(0);
    expect(snap.queue).toEqual({});
    expect(snap.pending_proposals).toBe(0);
    expect(snap.disk_free_bytes).toBeNull();
  });
});
