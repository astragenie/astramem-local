/**
 * Persistence for the evidence-requirement guard-drop counters (FEAT-485,
 * migration 030). Mirrors src/storage/relation-guard-log.ts field-for-field
 * (which itself mirrors src/storage/redaction-log.ts) -- counts + a reason
 * label only, never the raw atom text. See
 * migrations/030-evidence-guard-drops.sql for why this table exists: it is
 * the only place that can distinguish "the model never emits evidence for
 * lesson/decision atoms" from "the model emits lesson/decision atoms without
 * evidence and the guard drops every one" -- both look identical as a low/
 * zero evidence-population rate on `memories` alone.
 */

import type { DB } from './db.js';

export interface EvidenceGuardDropRow {
  reason: string;
  count: number;
}

/**
 * Write one `evidence_guard_drops` row per entry with `count > 0`. No-op
 * when `drops` is empty or every entry is zero -- nothing to record, no
 * wasted write (same guard `recordRelationGuardDrops`/`recordRedactionEvents`
 * use for an empty event list).
 */
export function recordEvidenceGuardDrops(
  db: DB,
  drops: EvidenceGuardDropRow[],
  sessionId: string | null,
): void {
  const nonZero = drops.filter((d) => d.count > 0);
  if (nonZero.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO evidence_guard_drops (reason, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of nonZero) {
    stmt.run(row.reason, row.count, sessionId, now);
  }
}

/** Sum of all guard-drop counts recorded since `sinceMs` (all-time when omitted). */
export function totalEvidenceGuardDrops(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM evidence_guard_drops WHERE created_at >= ?')
    .get(sinceMs) as { total: number };
  return row.total;
}
