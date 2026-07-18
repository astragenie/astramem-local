/**
 * Persistence for the FEAT-551 evidence-gated sweeper's guard-drop counters
 * (migration 053). Mirrors `src/storage/triage-guard-log.ts`'s two-table
 * split (FEAT-533) for the same reason: a reason+count-only table
 * (`evidence_gate_drops`) can say a drop happened, but never how often it
 * happened relative to how many passB atoms were even attempted — exactly
 * the "canary must measure rate, not existence" discipline this repo already
 * learned the hard way (entity extraction ran 87% broken for weeks behind a
 * green existence-only check). `evidence_gate_run_log` carries the
 * denominator (`atoms_attempted`) so a future doctor canary — or, nearer
 * term, FEAT-551's own AC-5 LoCoMo A/B measurement lane — can compute
 * `dropped / attempted` instead of reading `evidence_gate_drops` alone.
 */

import type { DB } from './db.js';
import type { EvidenceGateDropReason } from '../distill/evidence-gate.js';

export interface EvidenceGateDropRow {
  reason: EvidenceGateDropReason;
  count: number;
}

/** Write one `evidence_gate_drops` row per entry with `count > 0`. No-op
 *  when `drops` is empty or every entry is zero — same guard every sibling
 *  guard-drop table (relation/entity/validity/evidence) uses. */
export function recordEvidenceGateDrops(
  db: DB,
  drops: EvidenceGateDropRow[],
  sessionId: string | null,
): void {
  const nonZero = drops.filter((d) => d.count > 0);
  if (nonZero.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare<[string, number, string | null, number]>(
    'INSERT INTO evidence_gate_drops (reason, count, session_id, created_at) VALUES (?, ?, ?, ?)',
  );
  for (const row of nonZero) {
    stmt.run(row.reason, row.count, sessionId, now);
  }
}

/** Record one run-log row for a completed embedAndIndex call where the gate
 *  actually evaluated at least one passB atom. Mirrors
 *  `recordTriageRunLog`'s "only write when the tier actually ran" posture —
 *  a job with zero attempted atoms is a real, meaningful zero (the gate was
 *  on, but this run had no passB atoms), not a phantom row to pollute a
 *  future rate canary's denominator with every ordinary off-gate call. */
export function recordEvidenceGateRunLog(
  db: DB,
  row: { sessionId: string | null; atomsAttempted: number; atomsDropped: number },
): void {
  db.prepare<[string | null, number, number, number]>(
    'INSERT INTO evidence_gate_run_log (session_id, atoms_attempted, atoms_dropped, created_at) VALUES (?, ?, ?, ?)',
  ).run(row.sessionId, row.atomsAttempted, row.atomsDropped, Date.now());
}

/** Total passB atoms the gate evaluated since `sinceMs`. */
export function totalEvidenceGateAttempted(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(atoms_attempted), 0) AS n FROM evidence_gate_run_log WHERE created_at >= ?')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Total passB atoms the gate dropped since `sinceMs`. */
export function totalEvidenceGateDropped(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(atoms_dropped), 0) AS n FROM evidence_gate_run_log WHERE created_at >= ?')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Fraction (0..1) of attempted passB atoms dropped since `sinceMs`. `null`
 *  when zero atoms have been attempted in the window — rate is undefined,
 *  not 0 (same convention as `triageDropRate`/extraction-yield's
 *  `zeroYieldRate`). */
export function evidenceGateDropRate(db: DB, sinceMs = 0): number | null {
  const attempted = totalEvidenceGateAttempted(db, sinceMs);
  if (attempted === 0) return null;
  return totalEvidenceGateDropped(db, sinceMs) / attempted;
}
