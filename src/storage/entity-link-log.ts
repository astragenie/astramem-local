/**
 * Persistence for entity-link guard-drop counters (issue #200 AC-3,
 * migration 036). Mirrors src/storage/relation-guard-log.ts field-for-field
 * (same reason/count/session_id/created_at shape) -- counts + a reason
 * label only, never the raw entity name or memory text. See
 * migrations/037-entity-link-drops.sql for why this table exists: it is the
 * only place that can distinguish "the model never emitted an entity" from
 * "the model emitted entities but a write attempt failed for one" -- both
 * look identical as a memory with zero `memory_entities` rows.
 */

import type { DB } from './db.js';

export interface EntityLinkDropRow {
  reason: string;
  count: number;
}

/**
 * Write one `entity_link_drops` row per entry with `count > 0`. No-op when
 * `drops` is empty or every entry is zero -- nothing to record, no wasted
 * write (same guard `recordRelationGuardDrops` uses for an empty event
 * list).
 */
export function recordEntityLinkDrops(
  db: DB,
  drops: EntityLinkDropRow[],
  sessionId: string | null,
): void {
  const nonZero = drops.filter((d) => d.count > 0);
  if (nonZero.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO entity_link_drops (reason, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of nonZero) {
    stmt.run(row.reason, row.count, sessionId, now);
  }
}

/** Sum of all guard-drop counts recorded since `sinceMs` (all-time when omitted). */
export function totalEntityLinkDrops(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM entity_link_drops WHERE created_at >= ?')
    .get(sinceMs) as { total: number };
  return row.total;
}
