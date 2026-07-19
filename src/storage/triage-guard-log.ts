/**
 * Persistence for the LLM atom-triage tier (FEAT-533, migration 052; FEAT-547
 * v2 multi-verdict, migration 054). Two write paths, mirroring the
 * migration's own two-table split:
 *
 *  - `recordTriageGuardDrops` — one row per non-'keep' verdict OR per atom
 *    carrying a v2 signal (`corrected_type`/`evidence_supported` — FEAT-547),
 *    carrying memory_id/model/confidence (unlike
 *    src/storage/evidence-guard-log.ts and siblings, which only ever
 *    aggregate reason+count — this table needs per-atom detail for the
 *    manually reviewed dry-run agreement sample FEAT-533's own eval gate
 *    depends on).
 *  - `recordTriageRunLog` — one row per embedAndIndex call where triage
 *    actually ran, recording atoms_triaged/atoms_dropped so the doctor
 *    "Atom triage" canary can compute a RATE over a window
 *    (canary-must-measure-rate-not-existence) rather than reading
 *    triage_guard_drops' existence alone, which has no denominator.
 */

import type { DB } from './db.js';

export interface TriageGuardDropRow {
  /** The verdict label itself (e.g. 'junk', 'meta-echo', or 'keep' — FEAT-547
   *  v2: a 'keep' verdict IS written here when it carries a `corrected_type`
   *  or `evidence_supported` signal worth recording; pre-FEAT-547 callers
   *  only ever wrote non-'keep' reasons). */
  reason: string;
  /** Set when the atom persisted (mode 'dry-run', or any 'enabled'-mode row
   *  reaching this point — dropped 'enabled' junk/meta-echo atoms never
   *  reach insertWithCreateEvent); NULL when the atom was actually dropped
   *  (mode 'enabled' junk/meta-echo — no id exists to record). */
  memoryId: string | null;
  model: string;
  confidence: number;
  mode: 'dry-run' | 'enabled' | 'repair-only';
  sessionId: string | null;
  /** FEAT-547: the `corrected_type` this verdict proposed, when any —
   *  recorded regardless of whether the confidence gate actually applied it
   *  (see migrations/054-atom-triage-v2.sql's doc comment). `null`/omitted
   *  for every verdict that proposed no re-label. */
  correctedType?: string | null;
  /** FEAT-547: the `evidence_supported` verdict this atom's evidence quote
   *  received, when judged. `null`/omitted for every atom with no evidence
   *  quote to judge (or no verdict at all). */
  evidenceSupported?: boolean | null;
}

/** Write one `triage_guard_drops` row per entry. No-op on an empty array —
 *  nothing to record, no wasted write (same guard every guard-drop sibling
 *  table uses for an empty event list). Unlike the count-only guard-drop
 *  tables, this one writes ONE ROW PER VERDICT (not aggregated by reason),
 *  so there is no "count > 0" filter to apply here — every entry passed in
 *  is, by construction, a real verdict the caller already decided to
 *  record (a non-'keep' label, or a 'keep' label carrying a FEAT-547 v2
 *  signal). */
export function recordTriageGuardDrops(db: DB, drops: TriageGuardDropRow[]): void {
  if (drops.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<
    [string, string | null, string, number, string, string | null, number, string | null, number | null]
  >(
    'INSERT INTO triage_guard_drops ' +
    '(reason, memory_id, model, confidence, mode, session_id, created_at, corrected_type, evidence_supported) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const row of drops) {
    stmt.run(
      row.reason, row.memoryId, row.model, row.confidence, row.mode, row.sessionId, now,
      row.correctedType ?? null,
      row.evidenceSupported === undefined || row.evidenceSupported === null ? null : (row.evidenceSupported ? 1 : 0),
    );
  }
}

/** Record one triage-run row for a completed embedAndIndex call that
 *  actually triaged at least one atom (mode != 'off'). No zero-atoms-in
 *  guard needed the way recordExtractionYield doesn't need one either —
 *  every call that reaches this call site attempted a real triage batch. */
export function recordTriageRunLog(
  db: DB,
  row: { sessionId: string | null; atomsTriaged: number; atomsDropped: number },
): void {
  db.prepare<[string | null, number, number, number]>(
    'INSERT INTO triage_run_log (session_id, atoms_triaged, atoms_dropped, created_at) VALUES (?, ?, ?, ?)',
  ).run(row.sessionId, row.atomsTriaged, row.atomsDropped, Date.now());
}

/** Total atoms triaged (across all triage_run_log rows) since `sinceMs`. */
export function totalAtomsTriaged(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(atoms_triaged), 0) AS n FROM triage_run_log WHERE created_at >= ?')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Total atoms dropped (across all triage_run_log rows) since `sinceMs`. */
export function totalAtomsDropped(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(atoms_dropped), 0) AS n FROM triage_run_log WHERE created_at >= ?')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Fraction (0..1) of atoms triaged since `sinceMs` that were dropped.
 *  Returns `null` when zero atoms have been triaged in the window — rate is
 *  undefined, not 0 (same convention as extraction-yield-log's
 *  `zeroYieldRate`). */
export function triageDropRate(db: DB, sinceMs = 0): number | null {
  const triaged = totalAtomsTriaged(db, sinceMs);
  if (triaged === 0) return null;
  return totalAtomsDropped(db, sinceMs) / triaged;
}
