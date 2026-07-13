/**
 * Persistence for contradiction-judge run telemetry (FEAT-482, migration
 * 030). See that migration file's header for why this exists: neither
 * shipped LLM provider (Ollama, codex-subscription) reports a non-zero
 * `usage.usd`, so a dollar cap on the judge can never trip — call count and
 * wall-clock time are the real, visible cost signals, and this table is
 * where they're made visible instead of silently capped in a currency that
 * can't see them. Mirrors src/storage/relation-guard-log.ts's shape
 * (append-only counters, one doctor canary reads the latest state).
 */

import type { DB } from './db.js';

export interface ConsolidationJudgeRunStats {
  mode: 'dry-run' | 'enabled';
  judgeCalls: number;
  elapsedMs: number;
  capReached: boolean;
  wallClockCapReached: boolean;
}

/** Append one row. Called once per `runConsolidation()` invocation where
 *  contradiction detection was actually active (mode != 'off') — see
 *  src/consolidate/consolidate.ts. */
export function recordConsolidationJudgeRun(db: DB, stats: ConsolidationJudgeRunStats): void {
  db.prepare(`
    INSERT INTO consolidation_judge_runs
      (mode, judge_calls, elapsed_ms, cap_reached, wall_clock_cap_reached, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    stats.mode, stats.judgeCalls, stats.elapsedMs,
    stats.capReached ? 1 : 0, stats.wallClockCapReached ? 1 : 0, Date.now(),
  );
}

export interface ConsolidationJudgeRunRow extends ConsolidationJudgeRunStats {
  createdAt: number;
}

/** Most recent row, or `null` if contradiction detection has never run. */
export function latestConsolidationJudgeRun(db: DB): ConsolidationJudgeRunRow | null {
  const row = db.prepare(`
    SELECT mode, judge_calls, elapsed_ms, cap_reached, wall_clock_cap_reached, created_at
    FROM consolidation_judge_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() as
    | { mode: string; judge_calls: number; elapsed_ms: number; cap_reached: number; wall_clock_cap_reached: number; created_at: number }
    | undefined;
  if (!row) return null;
  return {
    mode: row.mode as 'dry-run' | 'enabled',
    judgeCalls: row.judge_calls,
    elapsedMs: row.elapsed_ms,
    capReached: row.cap_reached === 1,
    wallClockCapReached: row.wall_clock_cap_reached === 1,
    createdAt: row.created_at,
  };
}
