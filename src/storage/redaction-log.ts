/**
 * Persistence for stage-0 redaction counters (SEC-6). Counts + types only —
 * never the raw secret value. One row per (type, ingest) — see
 * migrations/005-security.sql for the `redaction_log` table.
 */

import type { DB } from './db.js';
import type { RedactionEvent } from '../redact/index.js';

export interface RedactionCountRow {
  type: string;
  count: number;
}

/** Collapse a flat event list into one row per type (count = occurrences). */
export function aggregateRedactionEvents(events: RedactionEvent[]): RedactionCountRow[] {
  const counts = new Map<string, number>();
  for (const e of events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return [...counts.entries()].map(([type, count]) => ({ type, count }));
}

/**
 * Write one `redaction_log` row per distinct type found in `events`. No-op
 * when `events` is empty (nothing to record, no wasted write).
 */
export function recordRedactionEvents(db: DB, events: RedactionEvent[], sessionId: string | null): void {
  if (events.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO redaction_log (type, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of aggregateRedactionEvents(events)) {
    stmt.run(row.type, row.count, sessionId, now);
  }
}
