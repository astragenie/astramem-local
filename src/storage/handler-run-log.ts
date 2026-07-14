/**
 * Per-run observability for pipeline job handlers (FEAT-495 item 4a).
 *
 * One row per `handler.handle()` INVOCATION (not per job-repo state
 * transition — a job that gets retried across attempts records one row per
 * attempt, matching what actually executed). Written by src/pipeline/
 * worker.ts at each terminal branch of its tick loop. Distinct from
 * job-repo.ts's `jobs` table, which tracks CURRENT state per job row (one
 * row per job, mutated in place) — this table is a history of executions,
 * so a handler that's been invoked 500 times shows 500 rows even though the
 * underlying job count may be far smaller (retries) or larger (jobs whose
 * handler was never registered never reach here at all — see worker.ts's
 * "No handler registered" branch, which does NOT call recordHandlerRun,
 * since the handler itself never ran).
 */

import type { DB } from './db.js';

export type HandlerRunStatus = 'success' | 'failed' | 'paused';

export interface HandlerRunRecord {
  handler: string;
  status: HandlerRunStatus;
  durationMs: number;
  errorType?: string | null;
  errorMessage?: string | null;
}

/** Append one row. Called once per handler.handle() invocation that actually ran (see file header). */
export function recordHandlerRun(db: DB, rec: HandlerRunRecord, createdAt: number = Date.now()): void {
  db.prepare(`
    INSERT INTO handler_runs (handler, status, duration_ms, error_type, error_message, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(rec.handler, rec.status, rec.durationMs, rec.errorType ?? null, rec.errorMessage ?? null, createdAt);
}

export interface HandlerRunSummary {
  handler: string;
  lastStatus: HandlerRunStatus;
  lastRunAt: number;
  lastDurationMs: number;
  lastErrorType: string | null;
  lastErrorMessage: string | null;
  totalRuns: number;
  totalFailed: number;
}

/**
 * One summary row per DISTINCT handler that has ever run, most-recently-run
 * first. Empty when handler_runs has no rows yet (nothing has ever been
 * dispatched to a handler this way, or the daemon just started).
 */
export function summarizeHandlerRuns(db: DB): HandlerRunSummary[] {
  const handlers = (db.prepare(`SELECT DISTINCT handler FROM handler_runs`).all() as { handler: string }[])
    .map(r => r.handler);

  const summaries: HandlerRunSummary[] = [];
  for (const handler of handlers) {
    const last = db.prepare(`
      SELECT status, duration_ms, error_type, error_message, created_at
      FROM handler_runs WHERE handler = ? ORDER BY created_at DESC, id DESC LIMIT 1
    `).get(handler) as
      | { status: HandlerRunStatus; duration_ms: number; error_type: string | null; error_message: string | null; created_at: number }
      | undefined;
    if (!last) continue; // unreachable given handlers was just derived from this same table, but keeps this function total

    const counts = db.prepare(`
      SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM handler_runs WHERE handler = ?
    `).get(handler) as { total: number; failed: number };

    summaries.push({
      handler,
      lastStatus: last.status,
      lastRunAt: last.created_at,
      lastDurationMs: last.duration_ms,
      lastErrorType: last.error_type,
      lastErrorMessage: last.error_message,
      totalRuns: counts.total,
      totalFailed: counts.failed,
    });
  }

  return summaries.sort((a, b) => b.lastRunAt - a.lastRunAt);
}
