-- 041: durable vec-index retry state (issue #209).
--
-- THE BUG: `SqliteVecStore.upsert` (src/vector/sqlite-vec.ts) correctly
-- throws on failure -- it does not lie. But every caller that could hit that
-- throw either let it kill the whole distill job with no per-atom recovery
-- (src/distill/stages/08-embed-index.ts, one bad atom's vec write aborting
-- every atom after it in the same batch) or caught it and returned
-- `{ ok: true, vec_indexed: false }` to the HTTP/MCP caller with nothing
-- durable behind it (src/server/routes/search.ts POST /remember,
-- src/mcp/server.ts remember tool) -- `vec_indexed: false` lived only in
-- that one response object. Nothing read it back, nothing retried, nothing
-- ever indexed that row again unless an operator noticed and ran
-- `astramem-local rebuild` (a full reindex of every memory, not a targeted
-- retry) by hand. Verified against production 2026-07-13: 13 of 18,863
-- active memories have no `memories_vec` row -- real, permanent,
-- unrecallable-by-vector-search data loss with a green write response.
--
-- THE FIX: one additive column, same ALTER TABLE ADD COLUMN pattern as
-- migrations 017/022/024/025/026/028/037 -- `needs_vec_index` is a durable
-- REAL-zero/BROKEN-zero marker (ADR-015) for exactly this row's vector
-- index state:
--   - needs_vec_index = 0 (default): either the vec upsert has never been
--     attempted and is expected to succeed inline (every pre-fix row, and
--     every post-fix row whose inline upsert succeeded), or a prior failure
--     has since been healed by the reembed retry path.
--   - needs_vec_index = 1: an upsert was attempted and failed (or, for
--     pre-existing rows below, is retroactively known to be missing) and
--     this row will not be found by vector search until the retry drain
--     (src/pipeline/handlers/reembed.ts, already the CLI `rebuild` path's
--     job kind -- reused here, not reinvented per ADR-015 rule 1) picks it
--     back up. The write-time callers (08-embed-index.ts, POST /remember,
--     MCP remember) enqueue a `reembed` job for the memory_id immediately on
--     failure; the `cleanup` job's existing 24h tick (src/pipeline/handlers/
--     cleanup.ts) also sweeps every still-flagged row on each pass as a
--     durable safety net independent of whether that immediate enqueue
--     itself succeeded.
--
-- This is also the exact denominator/numerator ADR-015 rule 6 asks for: the
-- future doctor canary (Lane 1, after PR #231 lands -- deliberately NOT
-- added in this migration/PR to avoid colliding with #231's checks.ts split)
-- is `COUNT(needs_vec_index=1) / COUNT(archived=0)`, not "some rows have
-- vectors."
--
-- Backfill: mark every existing ACTIVE memory that has no corresponding
-- memories_vec row as needing a vec index -- these are the 13 production
-- orphans (and any equivalent on any other install) that predate this
-- migration and would otherwise never self-heal. Archived memories are
-- excluded from the backfill (and from the rate denominator above) because
-- they are already excluded from recall by design; re-indexing them is
-- unnecessary work, not a correctness requirement.
ALTER TABLE memories ADD COLUMN needs_vec_index INTEGER NOT NULL DEFAULT 0;

UPDATE memories
SET needs_vec_index = 1
WHERE archived = 0
  AND rowid NOT IN (SELECT rowid FROM memories_vec);
