/**
 * Persistence for per-distill-job extraction yield (ADR-015 headline
 * finding, migration 042). Mirrors src/storage/relation-guard-log.ts
 * field-for-field (chunks_in/atoms_out instead of reason/count) -- a
 * counter table only, never atom or transcript text.
 *
 * A well-formed `{"atoms":[]}` extraction completes as SUCCESS at every
 * other layer, so a broken model producing zero atoms and a genuinely
 * empty transcript producing zero atoms are indistinguishable anywhere
 * else in the pipeline. This table is what lets the doctor "Extraction
 * yield" canary (src/doctor/checks.ts) compute a zero-yield RATE over a
 * recent window instead of an existence check -- see
 * canary-must-measure-rate-not-existence for why existence alone hid the
 * entity-extraction regression for weeks.
 */

import type { DB } from './db.js';

/**
 * Record one extraction-yield row for a completed distill job. No-op
 * guard is unnecessary here (unlike recordRelationGuardDrops' drops list):
 * every distill job that reaches this call site produced a real
 * chunks_in/atoms_out pair, including the zero-atom case -- a zero
 * atoms_out row is exactly the signal this table exists to capture, not
 * something to skip writing.
 */
export function recordExtractionYield(
  db: DB,
  yieldRow: { sessionId: string | null; chunksIn: number; atomsOut: number },
): void {
  db.prepare<[string | null, number, number, number]>(
    'INSERT INTO extraction_yield (session_id, chunks_in, atoms_out, created_at) VALUES (?, ?, ?, ?)',
  ).run(yieldRow.sessionId, yieldRow.chunksIn, yieldRow.atomsOut, Date.now());
}

/** Total number of extraction-yield rows recorded since `sinceMs` (all-time when omitted). */
export function totalYield(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM extraction_yield WHERE created_at >= ?')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Number of extraction-yield rows recorded since `sinceMs` whose chunks_in > 0 but atoms_out == 0 --
 *  a real distill job that yielded nothing, as opposed to a job with zero chunks in the first place. */
export function zeroYieldCount(db: DB, sinceMs = 0): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM extraction_yield WHERE created_at >= ? AND chunks_in > 0 AND atoms_out = 0')
    .get(sinceMs) as { n: number };
  return row.n;
}

/** Fraction (0..1) of runs since `sinceMs` with chunks_in > 0 that yielded zero atoms. Returns
 *  null when there is no eligible (chunks_in > 0) run in the window -- rate is undefined, not 0. */
export function zeroYieldRate(db: DB, sinceMs = 0): number | null {
  const eligibleRow = db
    .prepare('SELECT COUNT(*) AS n FROM extraction_yield WHERE created_at >= ? AND chunks_in > 0')
    .get(sinceMs) as { n: number };
  const eligible = eligibleRow.n;
  if (eligible === 0) return null;
  return zeroYieldCount(db, sinceMs) / eligible;
}
