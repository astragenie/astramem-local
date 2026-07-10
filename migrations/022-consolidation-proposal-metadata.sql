-- 022: consolidation_proposals.metadata_json (FEAT-456 SLICE-1).
--
-- Additive nullable column, no table rewrite needed (unlike migration 021's
-- CHECK-constraint rewrite) — SQLite supports ALTER TABLE ADD COLUMN
-- natively for a nullable column with no default-value complication.
--
-- kind='merge' rows leave this NULL forever (unchanged shape). kind=
-- 'contradiction' rows (the new producer FEAT-456 wires up) populate it
-- with the judge's verdict/confidence and excerpts captured at judge time:
--   {"verdict":"contradicts","confidence":0.87,"winner_excerpt":"...","loser_excerpt":"..."}
-- See src/consolidate/contradiction-judge.ts and consolidate.ts's
-- insertContradictionProposal.

ALTER TABLE consolidation_proposals ADD COLUMN metadata_json TEXT;
