import type { FastifyInstance } from 'fastify';
import { PKG_VERSION, WIRE_VERSIONS_SUPPORTED, SCHEMA_VERSION } from '../lib/wire-meta.js';
import { type Config, defaultConfig } from '../../config/config.js';
import type { DB } from '../../storage/db.js';
import type { HealthState } from '../health-state.js';
import { usefulnessRate } from '../../storage/usefulness.js';
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
        wire_versions_supported: WIRE_VERSIONS_SUPPORTED,
        schema_version: SCHEMA_VERSION,
        security: {
          redaction: config.security.redaction.enabled,
          encryption: config.security.encryption.enabled,
        },
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
              ...(db ? { queue: queueCounts(db) } : {}),
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

function queueCounts(db: DB): Record<string, number> {
  try {
    const rows = db.prepare(
      `SELECT state, COUNT(*) AS n FROM jobs GROUP BY state`,
    ).all() as Array<{ state: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) out[r.state] = r.n;
    return out;
  } catch {
    return {}; // jobs table absent (bare test DB) — degrade, never 500.
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
