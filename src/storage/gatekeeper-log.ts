/**
 * Persistence for the ingest gatekeeper (FEAT-548, migration 054). Two write
 * paths, mirroring `triage-guard-log.ts`'s (migration 052) two-table split:
 *
 *  - `recordGatekeeperSkips` — one row per 'skip' verdict, carrying
 *    model/confidence/mode/session_id — same per-verdict detail
 *    `triage_guard_drops` carries, needed for the manually reviewed
 *    dry-run false-skip review this FEAT's own bench gate (AC-4) depends on.
 *  - `recordGatekeeperRunLog` — one row per runPipeline call where the gate
 *    actually ran, recording chunks_evaluated/chunks_skipped so the doctor
 *    "Ingest gatekeeper" canary can compute a RATE over a window
 *    (canary-must-measure-rate-not-existence) rather than reading
 *    `gatekeeper_skips`' existence alone, which has no denominator.
 */

import type { DB } from './db.js';

export interface GatekeeperSkipRow {
  model: string;
  confidence: number;
  mode: 'dry-run' | 'enabled';
  sessionId: string | null;
}

/** Write one `gatekeeper_skips` row per entry. No-op on an empty array —
 *  nothing to record, no wasted write (same guard every guard-drop sibling
 *  table uses for an empty event list). */
export function recordGatekeeperSkips(db: DB, skips: GatekeeperSkipRow[]): void {
  if (skips.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string, string | null, number]>(
    'INSERT INTO gatekeeper_skips (model, confidence, mode, session_id, created_at) ' +
    'VALUES (?, ?, ?, ?, ?)',
  );
  for (const row of skips) {
    stmt.run(row.model, row.confidence, row.mode, row.sessionId, now);
  }
}

/** Record one gatekeeper-run row for a completed runPipeline call that
 *  actually ran the gate (mode != 'off'). No zero-chunks-in guard needed —
 *  every call that reaches this call site attempted a real gate sweep. */
export function recordGatekeeperRunLog(
  db: DB,
  row: { sessionId: string | null; chunksEvaluated: number; chunksSkipped: number },
): void {
  db.prepare<[string | null, number, number, number]>(
    'INSERT INTO gatekeeper_run_log (session_id, chunks_evaluated, chunks_skipped, created_at) VALUES (?, ?, ?, ?)',
  ).run(row.sessionId, row.chunksEvaluated, row.chunksSkipped, Date.now());
}

/** Total chunks evaluated (across all gatekeeper_run_log rows) since `sinceMs`. */
export function totalChunksEvaluated(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(chunks_evaluated), 0) AS n FROM gatekeeper_run_log WHERE created_at >= ?')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Total chunks skipped (across all gatekeeper_run_log rows) since `sinceMs`. */
export function totalChunksSkipped(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(chunks_skipped), 0) AS n FROM gatekeeper_run_log WHERE created_at >= ?')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Fraction (0..1) of chunks evaluated since `sinceMs` that were skipped.
 *  Returns `null` when zero chunks have been evaluated in the window — rate
 *  is undefined, not 0 (same convention as extraction-yield-log's
 *  `zeroYieldRate` / triage-guard-log's `triageDropRate`). */
export function gatekeeperSkipRate(db: DB, sinceMs = 0): number | null {
  const evaluated = totalChunksEvaluated(db, sinceMs);
  if (evaluated === 0) return null;
  return totalChunksSkipped(db, sinceMs) / evaluated;
}
