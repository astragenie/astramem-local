/**
 * Persistence for the FEAT-490 confidence-filter guard-drop counters
 * (migration 044). Mirrors src/storage/evidence-guard-log.ts field-for-field
 * (which itself mirrors relation-guard-log.ts / redaction-log.ts) — counts
 * + a reason label only, never the raw segment text. Exists so dropped
 * segments are visible in stats, never silent (FEAT-490 acceptance hint).
 */
import type { DB } from './db.js';
import type { ConfidenceDropReason } from '../audio/confidence-filter.js';

export interface TranscriptionGuardDropRow {
  reason: ConfidenceDropReason;
  count: number;
}

/**
 * Write one `transcription_guard_drops` row per entry with `count > 0`.
 * No-op when `drops` is empty or every entry is zero.
 */
export function recordTranscriptionGuardDrops(
  db: DB,
  drops: TranscriptionGuardDropRow[],
  sessionId: string | null,
): void {
  const nonZero = drops.filter((d) => d.count > 0);
  if (nonZero.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO transcription_guard_drops (reason, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of nonZero) {
    stmt.run(row.reason, row.count, sessionId, now);
  }
}

/** Sum of all guard-drop counts recorded since `sinceMs` (all-time when omitted). */
export function totalTranscriptionGuardDrops(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(count), 0) AS total FROM transcription_guard_drops WHERE created_at >= ?')
    .get(sinceMs) as { total: number };
  return row.total;
}
