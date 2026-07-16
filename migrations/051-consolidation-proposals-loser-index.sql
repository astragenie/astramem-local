-- 051: index consolidation_proposals for the correction-pending marker
-- lookup (issue #352B review finding 1, PR #378).
--
-- src/search/search.ts's correctionSignalForCandidates() runs on EVERY
-- search()/recall() call (not gated behind theta>0 -- the marker must be
-- visible even at the shipped theta=0 default), querying:
--
--   SELECT id, winner_id, loser_id, metadata_json FROM consolidation_proposals
--   WHERE kind = 'contradiction' AND status = 'pending' AND loser_id IN (...)
--
-- The only existing index on this table is the partial UNIQUE index from
-- migrations/008-consolidation.sql, keyed on MIN(winner_id, loser_id) /
-- MAX(winner_id, loser_id) -- a dedup guard, not usable for this lookup
-- (neither expression matches loser_id directly, and its own WHERE
-- predicate is `status = 'pending'` only, missing the `kind` term). Every
-- search was therefore a full table scan of consolidation_proposals, and
-- pending rows accumulate unbounded (768+ observed live pre-#372;
-- consolidation's knn candidate-selection widening will grow this further).
--
-- Partial index, scoped to exactly the query's WHERE predicate -- SQLite
-- only rides a partial index when the query's WHERE clause contains a
-- syntactically-equivalent sub-expression (same lesson as migration 045's
-- doc comment), so this index's WHERE clause is copied verbatim from the
-- search.ts query above. Partial (not a full index on loser_id) keeps the
-- index small: only pending contradiction rows are indexed, not the much
-- larger accepted/rejected/merge population.
CREATE INDEX idx_consolidation_proposals_pending_contradiction_loser
  ON consolidation_proposals (loser_id)
  WHERE kind = 'contradiction' AND status = 'pending';
