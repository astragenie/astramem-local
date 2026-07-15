/**
 * Persistence for consolidation run telemetry (P2.1 stabilization,
 * migration 050). One append-only row per real `runConsolidation()` call
 * (`ASTRA_SKIP_CONSOLIDATE=1` short-circuits before this write — see
 * src/consolidate/consolidate.ts). Mirrors
 * src/storage/consolidation-judge-log.ts's shape (append-only counters, one
 * doctor canary reads the latest row), but tracks the SCAN itself rather
 * than the judge sub-pass.
 *
 * Closes the reviewer MEDIUM finding (20260715T1640Z
 * review-stabilization-plan-architect-reviewer.md): `groupsSkipped` used to
 * be computed by `runConsolidation` and read nowhere — an oversized
 * (repo,type) group got ZERO consolidation coverage forever with no
 * operator-visible signal. `doctor`'s "Consolidation group coverage" check
 * (src/doctor/checks/consolidation-run.ts) reads the latest row here.
 */
import type { DB } from './db.js';

export interface ConsolidationRunLogStats {
  candidateSelection: 'full' | 'knn';
  groupsScanned: number;
  groupsSkippedCount: number;
  groupsSkippedAtoms: number;
  mergedCount: number;
  proposedCount: number;
}

export function recordConsolidationRun(db: DB, stats: ConsolidationRunLogStats): void {
  db.prepare(`
    INSERT INTO consolidation_run_log
      (candidate_selection, groups_scanned, groups_skipped_count, groups_skipped_atoms,
       merged_count, proposed_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    stats.candidateSelection, stats.groupsScanned, stats.groupsSkippedCount, stats.groupsSkippedAtoms,
    stats.mergedCount, stats.proposedCount, Date.now(),
  );
}

export interface ConsolidationRunLogRow extends ConsolidationRunLogStats {
  createdAt: number;
}

/** Most recent row, or `null` if consolidation has never run. */
export function latestConsolidationRun(db: DB): ConsolidationRunLogRow | null {
  const row = db.prepare(`
    SELECT candidate_selection, groups_scanned, groups_skipped_count, groups_skipped_atoms,
           merged_count, proposed_count, created_at
    FROM consolidation_run_log
    ORDER BY id DESC
    LIMIT 1
  `).get() as
    | {
        candidate_selection: string; groups_scanned: number; groups_skipped_count: number;
        groups_skipped_atoms: number; merged_count: number; proposed_count: number; created_at: number;
      }
    | undefined;
  if (!row) return null;
  return {
    candidateSelection: row.candidate_selection as 'full' | 'knn',
    groupsScanned: row.groups_scanned,
    groupsSkippedCount: row.groups_skipped_count,
    groupsSkippedAtoms: row.groups_skipped_atoms,
    mergedCount: row.merged_count,
    proposedCount: row.proposed_count,
    createdAt: row.created_at,
  };
}
