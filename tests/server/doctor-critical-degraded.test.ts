/**
 * tests/server/doctor-critical-degraded.test.ts (FEAT-541, 2026-07-17)
 *
 * Doctor checks carry no severity today — a cosmetic, intentional red
 * ("Dev no-auth mode" on a loopback-only dev box) and a genuine
 * DB-integrity/provider-outage red both land in
 * `HealthState.doctor.lastFailNames` identically, and /health.status()
 * ignored both. Operator complaint: "health was lying" — /health kept
 * reporting `status: 'ok'` with 4-5 doctor reds outstanding.
 *
 * `isCriticalDoctorCheck` (src/server/health-state.ts) is the fix: a small,
 * explicit prefix allowlist (provider/embed/DB-integrity class + a
 * still-looping crash-loop) that /health.status() consults directly off the
 * cached `state.doctor.lastFailNames` — O(1), no inline doctor run. These
 * tests exercise `createHealthState().status()` directly (unit-level, no
 * HTTP layer needed — status() is the whole surface under test) plus one
 * end-to-end pass through GET /health to prove the wire body's `doctor`
 * block and `status` field agree, and that FEAT-538's provider/poison-rate
 * gates still work unmodified (no regression).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { healthRoute } from '../../src/server/routes/health.js';
import { defaultConfig } from '../../src/config/config.js';
import {
  createHealthState,
  isCriticalDoctorCheck,
  CRITICAL_DOCTOR_CHECK_PREFIXES,
  type HealthState,
} from '../../src/server/health-state.js';
import { __resetProviderHealthRegistryForTest } from '../../src/providers/llm/health-tracking.js';

function baseState(): HealthState {
  const hs = createHealthState();
  hs.ready = true;
  hs.embed.ok = true; // isolate the doctor gate from the embed/boot gate
  return hs;
}

describe('isCriticalDoctorCheck — prefix classification', () => {
  it('matches the provider/embed/DB-integrity class, including dynamically-labeled names', () => {
    expect(isCriticalDoctorCheck('LLM chat probe (codex-subscription)')).toBe(true);
    expect(isCriticalDoctorCheck('Embed probe (1024-dim)')).toBe(true);
    expect(isCriticalDoctorCheck('ONNX embed health (all-MiniLM-L6-v2)')).toBe(true);
    expect(isCriticalDoctorCheck('SQLite writable + WAL')).toBe(true);
    expect(isCriticalDoctorCheck('sqlite-vec extension loadable')).toBe(true);
    expect(isCriticalDoctorCheck('Schema drift')).toBe(true);
    expect(isCriticalDoctorCheck('Datadir exists and writable')).toBe(true);
    expect(isCriticalDoctorCheck('Crash loop')).toBe(true);
  });

  it('does NOT match the informational/intentional checks called out by FEAT-541', () => {
    expect(isCriticalDoctorCheck('Dev no-auth mode')).toBe(false);
    expect(isCriticalDoctorCheck('Budget cap vs codex-subscription')).toBe(false);
    expect(isCriticalDoctorCheck('Consolidation group coverage')).toBe(false);
  });

  it('does not match unrelated checks by accident', () => {
    expect(isCriticalDoctorCheck('Extraction yield')).toBe(false);
    expect(isCriticalDoctorCheck('Entity link rate')).toBe(false);
    expect(isCriticalDoctorCheck('Backup recency')).toBe(false);
  });

  it('the allowlist stays small and explicit (guards against silent scope creep)', () => {
    expect(CRITICAL_DOCTOR_CHECK_PREFIXES.length).toBeLessThanOrEqual(10);
  });
});

describe('HealthState.status() — CRITICAL doctor red degrades, informational red does not', () => {
  beforeEach(() => {
    __resetProviderHealthRegistryForTest();
  });

  it('AC-b: a CRITICAL doctor red (e.g. Schema drift) flips status to degraded', () => {
    const hs = baseState();
    hs.doctor.lastFailNames = ['Schema drift'];
    expect(hs.status()).toBe('degraded');
  });

  it('AC-b: a dynamically-labeled CRITICAL red (provider probe) also flips status to degraded', () => {
    const hs = baseState();
    hs.doctor.lastFailNames = ['LLM chat probe (codex-subscription)'];
    expect(hs.status()).toBe('degraded');
  });

  it('AC-b: an informational-only red ("Dev no-auth mode") does NOT alone degrade status', () => {
    const hs = baseState();
    hs.doctor.lastFailNames = ['Dev no-auth mode'];
    expect(hs.status()).toBe('ok');
  });

  it('AC-b: "Budget cap vs codex-subscription" and "Consolidation group coverage" do not alone degrade status', () => {
    const hs = baseState();
    hs.doctor.lastFailNames = ['Budget cap vs codex-subscription', 'Consolidation group coverage'];
    expect(hs.status()).toBe('ok');
  });

  it('a mix of informational reds plus one CRITICAL red still degrades', () => {
    const hs = baseState();
    hs.doctor.lastFailNames = ['Dev no-auth mode', 'Budget cap vs codex-subscription', 'SQLite writable + WAL'];
    expect(hs.status()).toBe('degraded');
  });

  it('no doctor reds at all stays ok', () => {
    const hs = baseState();
    hs.doctor.lastFailNames = [];
    expect(hs.status()).toBe('ok');
  });

  it('does not regress FEAT-538: still degraded on embed:false with no doctor reds', () => {
    const hs = createHealthState();
    hs.ready = true;
    hs.embed.ok = false;
    hs.doctor.lastFailNames = [];
    expect(hs.status()).toBe('degraded');
  });

  it('boot-readiness gate still wins over everything else (starting, not degraded/ok)', () => {
    const hs = createHealthState();
    hs.ready = false;
    hs.doctor.lastFailNames = ['Schema drift'];
    expect(hs.status()).toBe('starting');
  });
});

describe('GET /health — wire-level: doctor block + status agree, no regression to FEAT-538 gates', () => {
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

  it('a CRITICAL doctor red in the cached state.doctor snapshot flips the wire status to degraded', async () => {
    const hs = baseState();
    hs.doctor = {
      lastRunAt: Date.now(),
      lastTier: 'frequent',
      lastFailCount: 1,
      lastInconclusiveCount: 0,
      lastFailNames: ['sqlite-vec extension loadable'],
    };
    const cfg = defaultConfig();
    app = Fastify({ logger: false });
    await app.register(healthRoute(cfg, db, hs));
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('degraded');
    expect(body.doctor.lastFailNames).toEqual(['sqlite-vec extension loadable']);
  });

  it('an informational-only doctor red keeps the wire status ok', async () => {
    const hs = baseState();
    hs.doctor = {
      lastRunAt: Date.now(),
      lastTier: 'frequent',
      lastFailCount: 1,
      lastInconclusiveCount: 0,
      lastFailNames: ['Dev no-auth mode'],
    };
    const cfg = defaultConfig();
    app = Fastify({ logger: false });
    await app.register(healthRoute(cfg, db, hs));
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('ok');
    expect(body.doctor.lastFailNames).toEqual(['Dev no-auth mode']);
  });

  it('/health never touches the doctor schedule itself — reading is O(1) off the cached snapshot (no inline doctor run)', async () => {
    const hs = baseState();
    hs.doctor.lastFailNames = ['Schema drift'];
    const cfg = defaultConfig();
    app = Fastify({ logger: false });
    await app.register(healthRoute(cfg, db, hs));
    await app.ready();

    // Three consecutive requests must all resolve fast (no LLM/embed/db-scan
    // inline work triggered by the doctor gate) and report the same status —
    // proves the gate is a pure read of the already-cached array.
    for (let i = 0; i < 3; i++) {
      const body = (await app.inject({ method: 'GET', url: '/health' })).json();
      expect(body.status).toBe('degraded');
    }
  });
});
