-- 058: job priority tiers (FEAT-482 fold, worker-starvation wave, item 1 of
-- 3 — see .claude/artifacts/crew/handoffs for the wave brief).
--
-- Adds `priority` INTEGER to `jobs` -- LOWER number is claimed FIRST
-- (JobRepo.claimPending's ORDER BY). `JobRepo.enqueue()` stamps the tier
-- for the job's `kind` onto the row at insert time (see JobRepo.JOB_PRIORITY)
-- so `claimPending()` never needs a per-call kind lookup.
--
-- DEFAULT 3 backfills every pre-058 row (and anything inserted through a
-- path that doesn't go through JobRepo.enqueue) to a NEUTRAL mid-tier value
-- -- same tier as 'consolidate' -- so an in-flight upgrade's already-pending
-- queue neither jumps the line ahead of, nor starves forever behind, freshly
-- tiered jobs enqueued after the upgrade (the claim-time aging term in
-- claimPending() means "behind" is temporary either way -- see its own doc
-- comment).
ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 3;

-- Composite index: claimPending's hot path always filters state='pending'
-- then orders by (an age-adjusted) priority, then created_at. Without this
-- the filter step falls back to the pre-existing idx_jobs_state(state,
-- created_at) and still has to sort the matching (small, but not free) set
-- by priority in memory on every single claim.
CREATE INDEX idx_jobs_state_priority ON jobs(state, priority, created_at);
