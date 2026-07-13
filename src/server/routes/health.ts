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
  return async (app: FastifyInstance) => {
    app.get('/health', async () => {
      const rate = db ? usefulnessRate(db, { sinceMs: Date.now() - SEVEN_DAYS_MS }) : { served: 0, used: 0, rate: null };
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
              ...(db
                ? { queue: queueCounts(db), pending_proposals: pendingProposals(db), memory_health: memoryHealthBlock(db) }
                : {}),
              ...(healthState.dataDir ? { disk_free_bytes: diskFree(healthState.dataDir) } : {}),
            }
          : {}),
      };
    });
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
