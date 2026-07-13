/**
 * Persistence for entity-relation extraction guard-drop counters (FEAT-481
 * SLICE-430, migration 029). Mirrors src/storage/redaction-log.ts field-for-
 * field (reasons instead of redaction types) -- counts + a reason label
 * only, never the raw subject/predicate/object text. See
 * migrations/029-relation-guard-drops.sql for why this table exists: it is
 * the only place that can distinguish "the model never emits a relation"
 * from "the model emits relations but the guard drops every one" -- both
 * look identical as a zero `entity_relations` row count.
 */

import type { DB } from './db.js';

export interface RelationGuardDropRow {
  reason: string;
  count: number;
}

/**
 * Write one `relation_guard_drops` row per entry with `count > 0`. No-op
 * when `drops` is empty or every entry is zero -- nothing to record, no
 * wasted write (same guard `recordRedactionEvents` uses for an empty event
 * list).
 */
export function recordRelationGuardDrops(
  db: DB,
  drops: RelationGuardDropRow[],
  sessionId: string | null,
): void {
  const nonZero = drops.filter((d) => d.count > 0);
  if (nonZero.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO relation_guard_drops (reason, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of nonZero) {
    stmt.run(row.reason, row.count, sessionId, now);
  }
}

/** Sum of all guard-drop counts recorded since `sinceMs` (all-time when omitted). */
export function totalRelationGuardDrops(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM relation_guard_drops WHERE created_at >= ?')
    .get(sinceMs) as { total: number };
  return row.total;
}
