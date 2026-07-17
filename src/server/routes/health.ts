import type { FastifyInstance } from 'fastify';
import {
  PKG_VERSION,
  WIRE_VERSIONS_SUPPORTED,
  CONTRACT_SCHEMA_VERSION,
  SCHEMA_VERSION,
} from '../lib/wire-meta.js';
import { type Config, defaultConfig } from '../../config/config.js';
import type { DB } from '../../storage/db.js';
import type { HealthState } from '../health-state.js';
import { isLoopbackHost } from '../lib/network.js';
import { usefulnessRate } from '../../storage/usefulness.js';
import { queryJobStates } from '../queries/dashboard.js';
import { buildMemoryHealthCheap, type MemoryHealthReport } from '../queries/memory-health.js';
import { statfsSync } from 'node:fs';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** TTL for the cached usefulness block below. ADR-010 marks the rate
 *  "measure only" — 60s of staleness on a 7-day aggregate is noise. */
const USEFULNESS_CACHE_TTL_MS = 60_000;

/**
 * db is optional so /health keeps working for any caller that doesn't wire a
 * DB (defensive default) — the usefulness block degrades to zeros rather
 * than 500ing.
 *
 * Wire compat: every pre-existing field is preserved and `ok` stays true
 * whenever the daemon is reachable ("reachable and serving"). The additive
 * `status` field carries the degraded-start signal (starting|ok|degraded).
 */
export function healthRoute(config: Config = defaultConfig(), db?: DB, healthState?: HealthState) {
  // usefulnessRate is a synchronous json_extract scan over the 7-day event
  // window — after a heavy session that window IS the whole memory_events
  // table, i.e. seconds of sync work ON THE EVENT LOOP per call. /health is
  // hit by the hang-watchdog (180s), monitoring probes, and the dashboard's
  // auto-refresh, so computing it per-request turned the liveness endpoint
  // itself into a loop-saturating amplifier during the 2026-07-15 incident
  // (probes stacked behind each other's scans until everything timed out and
  // the watchdog killed a healthy daemon). This is the same "accidental O(N)
  // on /health" class the memory_health comment below already bans — cache
  // it. A liveness endpoint must be O(1).
  let usefulnessCache: { at: number; rate: { served: number; used: number; rate: number | null } } | null = null;
  const cachedUsefulnessRate = (): { served: number; used: number; rate: number | null } => {
    if (!db) return { served: 0, used: 0, rate: null };
    const now = Date.now();
    if (usefulnessCache && now - usefulnessCache.at < USEFULNESS_CACHE_TTL_MS) return usefulnessCache.rate;
    try {
      const rate = usefulnessRate(db, { sinceMs: now - SEVEN_DAYS_MS });
      usefulnessCache = { at: now, rate };
      return rate;
    } catch {
      // FEAT-537: /health is exempt from the readiness gate and reachable
      // WHILE migrate() is still running in the default degraded-start boot
      // order (src/cli/serve.ts) — `memory_events` may not exist yet on a
      // fresh DB. Degrade to a safe zero-rate default instead of 500ing the
      // liveness endpoint, mirroring pendingProposals/memoryHealthBlock
      // below (same table-absent tolerance, same file). Deliberately NOT
      // cached — a real zero rate is legitimate and gets cached elsewhere,
      // but a table-absent degrade should be retried on the next request
      // once migrate finishes, not pinned for USEFULNESS_CACHE_TTL_MS.
      return { served: 0, used: 0, rate: null };
    }
  };

  return async (app: FastifyInstance) => {
    // Shared response builder. `fresh: false` (GET /health — the liveness
    // endpoint, watchdog target) prefers the pre-computed snapshot in
    // healthState.dbSnapshot and NEVER touches the DB when it is present;
    // `fresh: true` (GET /health/full — dashboard/human use) always
    // recomputes, byte-compatible with the old per-request behavior.
    const buildBody = (fresh: boolean) => {
      const rate = cachedUsefulnessRate();
      const snap = !fresh && healthState?.dbSnapshot ? healthState.dbSnapshot : null;
      // Lazy on purpose: only ever evaluated inside the `healthState ?`
      // spread below. An eager `const dbBlock = ...` here ran the three SQL
      // reads for every healthState-less caller (the dominant test-suite
      // pattern) and threw the result away — reintroducing exactly the
      // accidental-per-request-DB-touch class this slice exists to kill
      // (review finding, feat/p1-3).
      const dbBlock = () =>
        snap
          ? {
              queue: snap.queue,
              pending_proposals: snap.pending_proposals,
              memory_health: snap.memory_health,
              // Key-presence rule matches the fresh path: present whenever a
              // dataDir was configured at snapshot time (null on a statfs
              // failure), omitted only when there is no dataDir.
              ...(snap.disk_free_bytes !== undefined ? { disk_free_bytes: snap.disk_free_bytes } : {}),
              // P1.3: staleness is visible, never silently fresh-looking.
              snapshot_age_ms: Date.now() - snap.computedAt,
            }
          : {
              ...(db
                ? { queue: queueCounts(db), pending_proposals: pendingProposals(db), memory_health: memoryHealthBlock(db) }
                : {}),
              ...(healthState?.dataDir ? { disk_free_bytes: diskFree(healthState.dataDir) } : {}),
            };
      return {
        ok: true,
        version: PKG_VERSION,
        // U6 (#106): domain@gen wire-contract vocabulary (e.g. "atom@1"),
        // repurposed from the legacy flat v0.0/v1.0 envelope-negotiation list.
        wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
        // U6 (#106): coarse wire-CONTRACT generation — distinct from
        // schema_version below (the SQLite migration counter).
        contract_schema_version: CONTRACT_SCHEMA_VERSION,
        schema_version: SCHEMA_VERSION,
        security: {
          redaction: config.security.redaction.enabled,
          encryption: config.security.encryption.enabled,
        },
        // Observable signal that dev no-auth mode is actually active (config
        // says on AND network.host is loopback — see buildApp's devNoAuthActive
        // in src/server/app.ts, the same predicate that gates the auth hook).
        // Omitted entirely when inactive — additive, no shape change for the
        // common case.
        ...(config.auth?.devNoAuth === true && isLoopbackHost(config.network.host)
          ? { auth: 'dev-no-auth' as const }
          : {}),
        // ADR-010: recall-usefulness rate (v1: measure only, does not feed ranking).
        usefulness: {
          served_7d: rate.served,
          used_7d: rate.used,
          rate_7d: rate.rate,
        },
        // Degraded-start (D3) + real health checks (P1.3) — additive only.
        ...(healthState
          ? {
              status: healthState.status(),
              uptime_s: healthState.uptimeSeconds(),
              embed: {
                ok: healthState.embed.ok,
                last_ok_at: healthState.embed.lastOkAt,
                last_error: healthState.embed.lastError,
                attempts: healthState.embed.attempts,
              },
              worker: workerBlock(healthState),
              // P1.2 (2026-07-15 incident): event-loop lag over the current
              // window — the number a human had to hand-measure with curl
              // during the incident. O(1) native histogram read; numbers,
              // never a boolean (canary-rate rule).
              ...(healthState.eventLoopLag
                ? { event_loop: healthState.eventLoopLag.snapshot() }
                : {}),
              // A2-lite (ADR-015): last unattended doctor-schedule result —
              // readable without a human present, per the ADR's binding rule.
              doctor: healthState.doctor,
              ...dbBlock(),
            }
          : {}),
      };
    };

    app.get('/health', async () => buildBody(false));
    // Always-fresh variant for dashboards/humans — identical shape minus
    // snapshot_age_ms; the liveness endpoint above is the one the watchdog
    // and monitors must keep hitting.
    app.get('/health/full', async () => buildBody(true));
  };
}

/**
 * Computes the DB-backed /health block off the request path (P1.3) —
 * serve.ts calls this on an unref'd 30s interval and stores the result in
 * healthState.dbSnapshot. Same functions the fresh path uses; each degrades
 * to a safe default rather than throwing (see their doc comments), so the
 * refresher can never crash the daemon.
 */
export function computeHealthDbSnapshot(db: DB, dataDir?: string): import('../health-state.js').HealthDbSnapshot {
  return {
    computedAt: Date.now(),
    queue: queueCounts(db),
    pending_proposals: pendingProposals(db),
    memory_health: memoryHealthBlock(db),
    // undefined = no dataDir configured (key omitted on the wire);
    // null = dataDir configured but statfs failed (key present as null) —
    // same two-state rule the fresh path has always had.
    disk_free_bytes: dataDir ? diskFree(dataDir) : undefined,
  };
}

/**
 * Generous liveness window: the worker stamps lastTickAt at tick START, so a
 * single long-running job (LLM distill can take up to the 60s chat timeout)
 * must not read as "worker dead". 90s covers the worst handler + margin.
 */
const WORKER_ALIVE_WINDOW_MS = 90_000;

function workerBlock(hs: HealthState) {
  const last = hs.worker.lastTickAt;
  return {
    alive: last !== null && Date.now() - last < WORKER_ALIVE_WINDOW_MS,
    last_tick_at: last,
    last_tick_ago_ms: last === null ? null : Date.now() - last,
  };
}

/** FEAT-410 AC-2: delegates to the shared queryJobStates (queries/dashboard.ts)
 *  so /health and /dashboard compute job-state counts from one function. */
function queueCounts(db: DB): Record<string, number> {
  try {
    const rows = queryJobStates(db);
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.count;
    return out;
  } catch {
    return {}; // jobs table absent (bare test DB) — degrade, never 500.
  }
}

function pendingProposals(db: DB): number {
  try {
    return (db.prepare(
      `SELECT COUNT(*) AS n FROM consolidation_proposals WHERE status = 'pending'`,
    ).get() as { n: number }).n;
  } catch {
    return 0; // table absent (pre-008 schema in bare test DBs)
  }
}

/**
 * FEAT-444 AC-2: `memory_health` detail block — CHEAP TIER ONLY
 * (buildMemoryHealthCheap, src/server/queries/memory-health.ts). Every query
 * it runs is index-backed (idx_memories_archival_candidates, migration
 * 019/020's partial indexes, idx_jobs_state) — no full table scan, no
 * similarity computation. This is deliberate: docs/perf/2026-07-08-baseline.md
 * found `/health` was an accidental O(N) full scan once already this week
 * (fixed by migration 019); this block must never repeat that on the same
 * endpoint. The heavier byType/byScope/staleness breakdown and the deep
 * (near-duplicate/junk) metrics are reserved for `doctor` and the
 * `memory health` CLI report — see that module's file header.
 */
function memoryHealthBlock(db: DB): MemoryHealthReport | Record<string, never> {
  try {
    return buildMemoryHealthCheap(db);
  } catch {
    return {}; // never let a health-metric query 500 the liveness endpoint.
  }
}

function diskFree(dataDir: string): number | null {
  try {
    const s = statfsSync(dataDir);
    return s.bavail * s.bsize;
  } catch {
    return null;
  }
}
