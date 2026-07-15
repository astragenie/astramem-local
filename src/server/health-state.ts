/**
 * health-state.ts — mutable per-daemon health snapshot (D3).
 *
 * Written by the boot sequence, the background embed prober, and the job
 * worker; read by the /health route. Enables degraded-start: the daemon
 * binds its port immediately and reports 'starting' → 'ok' | 'degraded'
 * instead of dying when Ollama is slow to load a model at logon.
 */

export type DaemonStatus = 'starting' | 'ok' | 'degraded';

export interface EmbedHealth {
  /** null = not probed yet (starting); true/false = last probe outcome. */
  ok: boolean | null;
  lastOkAt: number | null;
  lastError: string | null;
  attempts: number;
}

export interface WorkerHealth {
  lastTickAt: number | null;
}

/**
 * Last-run summary of the unattended doctor schedule (A2-lite, ADR-015).
 * "Readable without a human present" is the ADR's binding rule — a red
 * scheduled run that only reached a log file nobody tails is the same
 * failure this ADR exists to kill, so the result is mirrored here and
 * surfaced at `/health` (src/server/routes/health.ts) in addition to being
 * logged. `null` fields mean "no scheduled run has completed yet" (a fresh
 * boot, or the daemon has been up for under one tick) — not "checked and
 * clean", the same distinction `CheckResult.inconclusive` protects at the
 * per-check level.
 */
export interface DoctorScheduleHealth {
  lastRunAt: number | null;
  lastTier: 'frequent' | 'full' | null;
  lastFailCount: number;
  lastInconclusiveCount: number;
  /** Names of checks that failed on the most recent run (either tier). */
  lastFailNames: string[];
}

export interface HealthState {
  readonly startedAt: number;
  embed: EmbedHealth;
  worker: WorkerHealth;
  doctor: DoctorScheduleHealth;
  /** Resolved data directory — lets /health report disk_free_bytes. */
  dataDir?: string;
  /**
   * Event-loop lag monitor (stabilization plan P1.2) — set by serve.ts at
   * boot, absent in non-daemon contexts (mcp-stdio, CLI, most tests). The
   * /health route surfaces its snapshot as `event_loop`; the
   * "Event loop lag" doctor check reads it in-process on the scheduled
   * runs. See src/server/event-loop-lag.ts.
   */
  eventLoopLag?: import('./event-loop-lag.js').EventLoopLagMonitor;
  /**
   * Pre-computed DB-backed /health fields (stabilization plan P1.3),
   * refreshed off the request path by serve.ts every 30s. When present,
   * the /health handler reads this instead of running its four sync SQLite
   * queries per request — under DB contention those queries queue the
   * liveness endpoint behind whatever else holds the connection, and the
   * watchdog probes /health every 180s (2026-07-15 incident amplifier
   * class). /health/full always computes fresh. `computedAt` is surfaced as
   * snapshot_age_ms so staleness is visible, never silently fresh-looking.
   */
  dbSnapshot?: HealthDbSnapshot;
  status(): DaemonStatus;
  uptimeSeconds(): number;
}

/** Shape of the pre-computed block — mirrors the /health fields it feeds. */
export interface HealthDbSnapshot {
  computedAt: number;
  queue: Record<string, number>;
  pending_proposals: number;
  /** buildMemoryHealthCheap's report, or {} when its query failed (same
   *  degrade-never-500 rule as the fresh path's memoryHealthBlock). */
  memory_health: import('./queries/memory-health.js').MemoryHealthReport | Record<string, never>;
  /** undefined = no dataDir configured (key omitted on the wire);
   *  null = dataDir configured but statfs failed (key present as null). */
  disk_free_bytes?: number | null;
}

export function createHealthState(now: () => number = Date.now): HealthState {
  const startedAt = now();
  const state: HealthState = {
    startedAt,
    embed: { ok: null, lastOkAt: null, lastError: null, attempts: 0 },
    worker: { lastTickAt: null },
    doctor: { lastRunAt: null, lastTier: null, lastFailCount: 0, lastInconclusiveCount: 0, lastFailNames: [] },
    status(): DaemonStatus {
      if (state.embed.ok === true) return 'ok';
      if (state.embed.ok === null) return 'starting';
      return 'degraded';
    },
    uptimeSeconds(): number {
      return Math.floor((now() - startedAt) / 1000);
    },
  };
  return state;
}
