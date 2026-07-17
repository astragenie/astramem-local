/**
 * health-state.ts — mutable per-daemon health snapshot (D3).
 *
 * Written by the boot sequence, the background embed prober, and the job
 * worker; read by the /health route. Enables degraded-start: the daemon
 * binds its port immediately and reports 'starting' → 'ok' | 'degraded'
 * instead of dying when Ollama is slow to load a model at logon.
 */

// FEAT-538: one-directional server -> providers dependency (same direction
// src/server/routes/search.ts already uses for buildLLMProvider) — see this
// file's ProviderHealth doc comment below for why the types/registry live in
// health-tracking.ts rather than here.
import { hasAnyProviderDown } from '../providers/llm/health-tracking.js';

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
 * Main-provider regression health (FEAT-538). Types + the process-wide
 * registry live in src/providers/llm/health-tracking.ts (the providers
 * layer), NOT here — `buildLLMProvider()` (src/providers/index.ts) wraps
 * every provider it constructs in a chat()-observing decorator that feeds
 * that registry, keyed by provider name. NOT a periodic probe: a metered
 * doctor-style poll every few minutes against codex-subscription would be
 * the exact FEAT-482 self-DoS class this repo already got burned by once;
 * this reads the ERROR SIGNAL off real distill/compact/judge traffic as it
 * happens. `status()` below calls `hasAnyProviderDown()` — a live O(1)
 * registry read, never a probe — which itself only flips a given provider's
 * entry to 'down' after N consecutive qualifying failures (AC-5: one
 * transient blip must never flip this) and resets to 'up' on the very next
 * success. See health-tracking.ts's module doc comment for the full design
 * (including why it's keyed by provider name, not by extraction/compaction
 * role).
 */

/** Cached distill-session poison-rate snapshot (FEAT-538) — reuses
 *  memory-health.ts's `distillSessionStats` + doctor's existing
 *  `POISON_RATE_ALARM`/`MEANINGFUL_USAGE_THRESHOLD` floors (previously only
 *  consulted by the `tier:'full'`, 24h-cadence `checkMemoryHealth` doctor
 *  check), refreshed on the same 30s off-request-path timer as the rest of
 *  `HealthDbSnapshot` — see `computeHealthDbSnapshot` in
 *  src/server/routes/health.ts. */
export interface DistillPoisonRateSnapshot {
  poison: number;
  terminal: number;
  rate: number | null;
  /** true when `terminal >= MEANINGFUL_USAGE_THRESHOLD && rate >=
   *  POISON_RATE_ALARM` — the same gate checkMemoryHealth's ok:false branch
   *  uses, so a fresh install's first couple of poison jobs never trips this. */
  alarmed: boolean;
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
  /**
   * Boot-readiness gate (Wave 0 Item 3: bind port before migrate/recover).
   * Defaults to `true` — every existing caller that never touches this field
   * (bare test apps, hand-built HealthState objects) sees exactly the old
   * `status()` behavior, driven by `embed` alone. `serve.ts`'s non-strict
   * boot path is the only writer that ever sets this `false`: right after
   * `createHealthState()`, before binding the port, then back to `true`
   * once the deferred migrate/recoverOrphans/provider-setup continuation
   * finishes. While `false`, `status()` reports 'starting' regardless of
   * `embed`, and `buildApp`'s readiness-gate hook (src/server/app.ts) 503s
   * every route except /health, /health/full, /version — a half-migrated DB
   * must never serve a real request.
   */
  ready: boolean;
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
  /** FEAT-538: cached distill-session poison-rate — see
   *  DistillPoisonRateSnapshot's doc comment. Optional: absent on a snapshot
   *  built before this field existed (defensive — none should exist in
   *  practice since dbSnapshot is only ever process-local), and on a
   *  hand-built test snapshot that predates FEAT-538. */
  distill_poison_rate?: DistillPoisonRateSnapshot;
}

export function createHealthState(now: () => number = Date.now): HealthState {
  const startedAt = now();
  const state: HealthState = {
    startedAt,
    embed: { ok: null, lastOkAt: null, lastError: null, attempts: 0 },
    worker: { lastTickAt: null },
    doctor: { lastRunAt: null, lastTier: null, lastFailCount: 0, lastInconclusiveCount: 0, lastFailNames: [] },
    ready: true,
    status(): DaemonStatus {
      if (!state.ready) return 'starting';
      if (state.embed.ok === null) return 'starting';
      if (state.embed.ok === false) return 'degraded';
      // FEAT-538: a live daemon whose main LLM provider is failing, or whose
      // poison rate is climbing fast, is not "ok" even though embed and the
      // worker loop are both fine — this is the ADR-015 gap the 2026-07-17
      // codex-401 incident exposed (187 poison jobs, /health said "ok" the
      // whole time). Both reads are O(1) and never probe anything on the
      // request path: hasAnyProviderDown() reads the module-wide registry
      // src/providers/index.ts's buildLLMProvider() feeds on every real
      // chat() call, and the poison rate comes from the same 30s-refreshed
      // dbSnapshot every other /health DB field already uses.
      if (hasAnyProviderDown()) return 'degraded';
      if (state.dbSnapshot?.distill_poison_rate?.alarmed) return 'degraded';
      return 'ok';
    },
    uptimeSeconds(): number {
      return Math.floor((now() - startedAt) / 1000);
    },
  };
  return state;
}
