-- 050: P2.1 stabilization -- k-NN candidate selection for consolidation
-- (src/consolidate/consolidate.ts). Two small additive tables, both
-- opt-in-adjacent (written only when the corresponding feature is active):
--
-- consolidation_cursor: single-row resumable cursor (id=1 enforced,
-- mirrors sync_pull_state's shape from migration 010). Only written when
-- `consolidation.maxCandidatePairsPerRun` is set (an opt-in pair-budget
-- ceiling, default null/off). Persists which (repo,type) group to resume
-- scanning from on the NEXT runConsolidation() call once the ceiling is
-- hit mid-sweep -- a naive Map-insertion-order (or raw SQL scan order)
-- truncation would otherwise always start from the same groups every run
-- and permanently starve whichever groups sort last. group_key IS NULL
-- means "start from the beginning" (no cursor persisted yet, or the last
-- run completed a full sweep and reset it).
--
-- consolidation_run_log: append-only telemetry, one row per real
-- runConsolidation() call (ASTRA_SKIP_CONSOLIDATE short-circuits before
-- reaching this write). Closes the reviewer MEDIUM finding
-- (20260715T1640Z review-stabilization-plan-architect-reviewer.md):
-- `ConsolidateSummary.groupsSkipped` was computed but read nowhere -- an
-- oversized (repo,type) group got ZERO consolidation coverage forever with
-- no operator-visible signal. doctor's "Consolidation group coverage"
-- check (src/doctor/checks/consolidation-run.ts) reads the latest row.
CREATE TABLE consolidation_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  group_key TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE consolidation_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  candidate_selection TEXT NOT NULL,
  groups_scanned INTEGER NOT NULL,
  groups_skipped_count INTEGER NOT NULL,
  groups_skipped_atoms INTEGER NOT NULL,
  merged_count INTEGER NOT NULL,
  proposed_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_consolidation_run_log_created ON consolidation_run_log(created_at DESC);
