/**
 * Persistence for atom-validity guard-drop counters (issue #205 follow-up,
 * migration 038). Mirrors src/storage/relation-guard-log.ts field-for-field —
 * counts + a reason label only, never the raw date text.
 *
 * See migrations/038-validity-guard-drops.sql for why this table exists: it is
 * the only place that can distinguish "the model never states an end date" (a
 * REAL zero) from "the model states end dates and the guard rejects every one"
 * (a BROKEN zero). Both look identical as a zero `valid_to` population count,
 * which is exactly the ambiguity ADR-015 forbids.
 */

import type { DB } from './db.js';

export interface ValidityGuardDropRow {
  reason: string;
  count: number;
}

/**
 * Write one `validity_guard_drops` row per entry with `count > 0`. No-op when
 * `drops` is empty or every entry is zero.
 */
export function recordValidityGuardDrops(
  db: DB,
  drops: ValidityGuardDropRow[],
  sessionId: string | null,
): void {
  const nonZero = drops.filter((d) => d.count > 0);
  if (nonZero.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO validity_guard_drops (reason, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of nonZero) {
    stmt.run(row.reason, row.count, sessionId, now);
  }
}

/** Total validity-guard drops recorded at or after `since` (epoch ms). */
export function totalValidityGuardDrops(db: DB, since: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS n FROM validity_guard_drops WHERE created_at >= ?')
    .get(since) as { n: number };
  return row.n;
}
