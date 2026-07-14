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
  /**
   * Count of `judgeCalls` that fell back to FALLBACK_VERDICT ('unrelated',
   * confidence 0) due to a parse failure or thrown/rejected `chat()` call
   * (contradiction-judge.ts's `onFallback`), rather than a real judge
   * verdict. Optional/defaults to 0 for callers that predate this field.
   * `judgeErrors === judgeCalls` (with judgeCalls > 0) means the judge
   * never actually classified a single pair this run — see checks.ts's
   * "Consolidation judge" check, which flags exactly that case (same
   * failure shape as issues #190/#200: a canary reporting activity that
   * doesn't distinguish real signal from every call silently failing).
   */
  judgeErrors?: number;
  /**
   * FEAT-499 stage 1 (instrument-first, migration 044): of `judgeCalls`
   * REAL judge dispatches this run, how many had a pair cosine similarity
   * in the near-merge-threshold band [0.90, mergeThreshold) — see
   * src/consolidate/consolidate.ts's `NEAR_MERGE_THRESHOLD_MIN` constant
   * and the FEAT-499 comments around the judge-call site. Purely
   * observational; no skip/filter behavior exists yet — this number is the
   * evidence a stage-2 short-circuit would later be gated on (>= 20% of
   * calls). Optional/defaults to 0 for callers that predate this field.
   */
  judgeCallsNearThreshold?: number;
}

/** Append one row. Called once per `runConsolidation()` invocation where
 *  contradiction detection was actually active (mode != 'off') — see
 *  src/consolidate/consolidate.ts. */
export function recordConsolidationJudgeRun(db: DB, stats: ConsolidationJudgeRunStats): void {
  db.prepare(`
    INSERT INTO consolidation_judge_runs
      (mode, judge_calls, elapsed_ms, cap_reached, wall_clock_cap_reached, judge_errors, judge_calls_near_threshold, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    stats.mode, stats.judgeCalls, stats.elapsedMs,
    stats.capReached ? 1 : 0, stats.wallClockCapReached ? 1 : 0, stats.judgeErrors ?? 0,
    stats.judgeCallsNearThreshold ?? 0, Date.now(),
  );
}

export interface ConsolidationJudgeRunRow extends Required<ConsolidationJudgeRunStats> {
  createdAt: number;
}

/** Most recent row, or `null` if contradiction detection has never run. */
export function latestConsolidationJudgeRun(db: DB): ConsolidationJudgeRunRow | null {
  const row = db.prepare(`
    SELECT mode, judge_calls, elapsed_ms, cap_reached, wall_clock_cap_reached, judge_errors,
           judge_calls_near_threshold, created_at
    FROM consolidation_judge_runs
    ORDER BY id DESC
    LIMIT 1
  `).get() as
    | {
        mode: string; judge_calls: number; elapsed_ms: number; cap_reached: number; wall_clock_cap_reached: number;
        judge_errors: number; judge_calls_near_threshold: number; created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    mode: row.mode as 'dry-run' | 'enabled',
    judgeCalls: row.judge_calls,
    elapsedMs: row.elapsed_ms,
    capReached: row.cap_reached === 1,
    wallClockCapReached: row.wall_clock_cap_reached === 1,
    judgeErrors: row.judge_errors,
    judgeCallsNearThreshold: row.judge_calls_near_threshold,
    createdAt: row.created_at,
  };
}
