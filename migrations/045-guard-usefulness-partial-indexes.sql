-- 045: guard the two usefulness partial indexes against malformed
-- payload_json (FEAT-495 item 3).
--
-- migrations/019-health-agent-profile-indexes.sql (recreated verbatim by
-- 021/025's table rebuilds) added two partial indexes on memory_events whose
-- WHERE clause calls json_extract(payload_json, '$.family') directly. A
-- partial index's WHERE expression is evaluated on EVERY INSERT/UPDATE to
-- the table (to decide index membership), not just on matching SELECTs.
--
-- Precise condition (corrected 2026-07-14 per review -- the original wording
-- here overstated this as "any event_type"; it is not): SQLite DOES
-- short-circuit the AND on the leading `event_type = 'usefulness'` operand --
-- confirmed empirically (better-sqlite3-multiple-ciphers, both a bare INSERT
-- and dedupInsertEvent's real INSERT...SELECT...WHERE NOT EXISTS shape,
-- across empty/50-healthy/50-unrelated-row table states): a malformed-
-- payload row whose event_type is 'create', 'promote_scope', etc. does NOT
-- throw. The throw fires ONLY when the malformed row's own event_type
-- equals the index's own equality predicate ('usefulness', for both indexes
-- below) -- the first operand is then true, forcing json_extract to
-- actually evaluate the malformed payload_json.
--
-- memory_events.payload_json is fed by BOTH local writers
-- (MemoryEventRepo.append) and the sync pull path (src/sync/puller.ts's
-- dedupInsertEvent, which inserts a remote device's payload_json verbatim,
-- unvalidated -- see src/storage/json-guard.ts's file header). Before this
-- fix, a malformed 'usefulness'-typed event arriving in a pull batch (a
-- realistic scenario for a buggy/corrupted remote device -- usefulness
-- events are the most numerous synced type) would make its plain INSERT
-- throw, which happens inside the SAME transaction as the entire pull round
-- (src/sync/puller.ts's pullOnce) -- rolling back every OTHER event in that
-- batch too (regardless of THEIR event_type) and leaving the watermark
-- stuck, so the next pull re-fetches and re-fails on the same batch forever.
-- Guarding unconditionally below (not just for the 'usefulness' case) is
-- still correct and harmless for the event_types that were never at risk --
-- it costs nothing and closes the gap for good if a future migration ever
-- changes these indexes' leading predicate.
--
-- Fix: same `CASE WHEN json_valid(x) THEN x ELSE '[]' END` guard used at the
-- read call sites (src/storage/json-guard.ts's safeJsonColumn), applied to
-- the index's own WHERE predicate. json_extract on the substituted '[]'
-- returns NULL instead of throwing, so a malformed row simply doesn't match
-- either partial index (correct -- it can't be a real 'recall_served' or
-- 'recall_used' event) instead of blocking the whole insert.
--
-- The read-side queries (src/storage/usefulness.ts) were updated in the same
-- change to use the IDENTICAL guarded expression text -- SQLite's partial
-- index matching requires the query's WHERE clause to contain a
-- syntactically-equivalent sub-expression to keep riding the index (verified
-- empirically: EXPLAIN QUERY PLAN still reports `USE INDEX` after this
-- change, not a full-table-scan regression of the exact perf cliff migration
-- 019 fixed).
--
-- idx_memory_events_correction_type (also created by 019/025) does not
-- reference payload_json at all and is untouched here.
DROP INDEX IF EXISTS idx_memory_events_usefulness_served;
DROP INDEX IF EXISTS idx_memory_events_usefulness_used;

CREATE INDEX idx_memory_events_usefulness_served ON memory_events(created_at, atom_id)
  WHERE event_type = 'usefulness'
    AND json_extract((CASE WHEN json_valid(payload_json) THEN payload_json ELSE '[]' END), '$.family') = 'recall_served';

CREATE INDEX idx_memory_events_usefulness_used ON memory_events(created_at, atom_id)
  WHERE event_type = 'usefulness'
    AND json_extract((CASE WHEN json_valid(payload_json) THEN payload_json ELSE '[]' END), '$.family') = 'recall_used';
