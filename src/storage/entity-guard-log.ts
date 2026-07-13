/**
 * Persistence for entity-name-quality guard-drop counters (issue #207,
 * migration 033). Mirrors src/storage/relation-guard-log.ts field-for-field
 * (a separate table, not a shared one -- see migrations/033-entity-name-
 * drops.sql for why) -- counts + a reason label only, never the raw dropped
 * name.
 */

import type { DB } from './db.js';

export interface EntityGuardDropRow {
  reason: string;
  count: number;
}

/**
 * Write one `entity_name_drops` row per entry with `count > 0`. No-op when
 * `drops` is empty or every entry is zero -- nothing to record, no wasted
 * write (same guard `recordRelationGuardDrops` uses).
 */
export function recordEntityGuardDrops(
  db: DB,
  drops: EntityGuardDropRow[],
  sessionId: string | null,
): void {
  const nonZero = drops.filter((d) => d.count > 0);
  if (nonZero.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO entity_name_drops (reason, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of nonZero) {
    stmt.run(row.reason, row.count, sessionId, now);
  }
}

/** Sum of all guard-drop counts recorded since `sinceMs` (all-time when omitted). */
export function totalEntityGuardDrops(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM entity_name_drops WHERE created_at >= ?')
    .get(sinceMs) as { total: number };
  return row.total;
}
