-- 059: three read-path indexes (Wave-3 storage+perf track).
--
-- 1. idx_memories_project_valid_created — the exact (project, valid_to,
--    created_at, id) shape src/recall/pack.ts::selectPack filters and orders
--    by (`WHERE project = ? [AND branch = ?] AND valid_to IS NULL ORDER BY
--    created_at DESC LIMIT 500`). `id DESC` is a tiebreaker: two rows can
--    share the same `created_at` (millisecond collisions are routine under
--    batch/distill ingest), and without a deterministic second sort key
--    SQLite's tie order is whatever the b-tree happens to hand back — which
--    can change between runs and silently reshuffle which rows land inside
--    the 500-row CANDIDATE_LIMIT cutoff. selectPack's own ORDER BY was
--    updated in the same change to `created_at DESC, id DESC` so the index
--    is actually usable for the sort, not just the filter (a query whose
--    ORDER BY doesn't match the index's trailing columns still forces a
--    temp b-tree sort even when the leading WHERE columns use the index).
--    `branch` is deliberately NOT part of this index: selectPack only
--    filters on it when a caller explicitly passes one (the common path
--    omits it entirely), so a leading (project, valid_to, branch, ...)
--    shape would make the branch-less majority case straddle a column the
--    query never binds — SQLite still rides this index for that case (it
--    just filters branch afterward when present), so one index shape covers
--    both call shapes without duplicating it.
CREATE INDEX IF NOT EXISTS idx_memories_project_valid_created
  ON memories(project, valid_to, created_at DESC, id DESC);

-- 2. idx_memories_needs_vec_index — partial index covering the two
--    `needs_vec_index = 1` sweep queries (MemoryRepo.listNeedingVecIndex /
--    listOversizeNeedingVecIndex, both read by cleanup.ts's 24h vec-index
--    sweep and the oversize-scanner's shorter-cadence pass). `needs_vec_index`
--    is 0 for the overwhelming majority of rows once a corpus is healthy, so
--    a partial index keeps the maintained index tiny regardless of table size
--    — same shape as the migration 045 usefulness partial indexes.
CREATE INDEX IF NOT EXISTS idx_memories_needs_vec_index
  ON memories(updated_at) WHERE needs_vec_index = 1;

-- 3. idx_memory_events_unsynced — partial index on the shipper's hot read
--    (src/sync/shipper.ts::listUnsynced), which orders unsynced rows by
--    `seq ASC` — NOT synced_at (there is no synced_at predicate in the
--    ORDER BY; synced_at only appears in the WHERE as `IS NULL`). Indexing
--    seq (the actual sort/scan key) rather than synced_at is what lets this
--    ride an index for both the filter and the order, on a table that is
--    also the append-only memory_events log and therefore only ever grows.
CREATE INDEX IF NOT EXISTS idx_memory_events_unsynced
  ON memory_events(seq) WHERE synced_at IS NULL;
