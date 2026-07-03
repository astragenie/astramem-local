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

export interface HealthState {
  readonly startedAt: number;
  embed: EmbedHealth;
  worker: WorkerHealth;
  /** Resolved data directory — lets /health report disk_free_bytes. */
  dataDir?: string;
  status(): DaemonStatus;
  uptimeSeconds(): number;
}

export function createHealthState(now: () => number = Date.now): HealthState {
  const startedAt = now();
  const state: HealthState = {
    startedAt,
    embed: { ok: null, lastOkAt: null, lastError: null, attempts: 0 },
    worker: { lastTickAt: null },
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
