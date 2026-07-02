-- 008: consolidation proposals (ADR-004 stage 9, Wave 4b).
--
-- Propose-only queue for consolidation actions that must NOT auto-apply
-- (strategy Pass 6 A4: auto-invalidation is trust-destroying). The offline
-- consolidation job writes 'pending' rows; the user accepts or rejects via
-- REST/MCP. Auto-merges (similarity above the merge threshold) bypass this
-- table entirely — they go straight through the supersede event flow, which
-- is non-destructive by construction (W4 fix: originals kept as superseded,
-- lineage recorded in memories.derived_from).
--
-- kind 'merge'          — borderline near-duplicate pair, user confirms merge.
-- kind 'contradiction'  — reserved for the v1.x LLM contradiction detector;
--                          the confirm flow is identical, only the producer differs.

CREATE TABLE consolidation_proposals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('merge', 'contradiction')),
  -- winner_id: the atom that would survive; loser_id: the atom that would be
  -- superseded. Pair is stored directionally after winner selection.
  winner_id TEXT NOT NULL,
  loser_id TEXT NOT NULL,
  similarity REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'accepted', 'rejected')),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER
);

-- One live proposal per unordered pair — the job dedups on this before insert.
CREATE UNIQUE INDEX idx_consolidation_pair_pending
  ON consolidation_proposals (MIN(winner_id, loser_id), MAX(winner_id, loser_id))
  WHERE status = 'pending';
