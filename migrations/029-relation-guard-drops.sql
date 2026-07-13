-- 029: entity-relation extraction guard-drop counters (FEAT-481 SLICE-430).
--
-- Counts + reasons only -- never the raw subject/predicate/object text --
-- same discipline as redaction_log (005-security.sql), which this table
-- mirrors field-for-field (type/count/session_id/created_at ->
-- reason/count/session_id/created_at).
--
-- Written from two guard points, one row appended per (reason, run):
-- 1. src/distill/stages/05-extract.ts's filterAtomRelations -- a triple
--    whose predicate isn't in the closed enum, is missing subject/object,
--    has subject === object, or fails the same-atom no-hallucination check
--    (design doc §2.2/§2.3) never reaches stage 8 at all.
-- 2. src/distill/stages/08-embed-index.ts's defensive
--    `if (!subjectId || !objectId) continue` -- should not happen post-
--    stage-5 filtering, but counted under its own reason so it's
--    distinguishable from a stage-5 drop if it ever fires.
--
-- Exists so the doctor "Entity relations extraction" canary
-- (src/doctor/checks.ts) can tell apart two failure modes that look
-- identical from `entity_relations` alone (zero rows either way):
--   - the model never emits a relations[] triple at all (0 rows, 0 drops)
--   - the model emits triples but the guard drops every single one
--     (0 rows, drops > 0)
-- Doctor cannot distinguish these from entity_relations row count alone --
-- this table is the only place that distinction is observable.
CREATE TABLE relation_guard_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_relation_guard_drops_created ON relation_guard_drops(created_at DESC);
CREATE INDEX idx_relation_guard_drops_reason ON relation_guard_drops(reason, created_at DESC);
