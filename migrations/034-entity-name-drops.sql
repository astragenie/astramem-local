-- 034: entity-name guard-drop counters (issue #207).
--
-- Counts + reasons only -- never the raw dropped name -- same discipline as
-- relation_guard_drops (029-relation-guard-drops.sql) and evidence_guard_drops
-- (030-evidence-guard-drops.sql), which this table mirrors field-for-field
-- (reason/count/session_id/created_at). A SEPARATE table from
-- relation_guard_drops, not a shared one, so that table's own guardDrops7d
-- sum (read by the "Entity relations extraction" doctor check) stays scoped
-- to relation-guard reasons only and is never diluted by an unrelated guard's
-- activity -- same one-table-per-guard-class precedent evidence_guard_drops
-- already set.
--
-- Written from one guard point: src/distill/stages/05-extract.ts's
-- filterAtomEntities -- an entities[] item whose name is a bare issue/PR
-- reference ("#110"), a bare number ("123"), or below the minimum length
-- floor never reaches stage 8 (the entities/memory_entities write) at all.
--
-- Exists so the doctor "Entity name quality" canary (src/doctor/checks.ts)
-- can tell apart two things that look identical from a stale entities-table
-- snapshot alone:
--   - the model/guard have stopped producing new junk names (0 drops because
--     nothing junk was emitted post-fix)
--   - the guard is actively catching and dropping junk on an ongoing basis
--     (drops > 0) -- a visible, measurable "the fix is working" signal,
--     distinct from the separate question of whether OLD junk rows (written
--     before this guard existed) still sit in the entities table.
CREATE TABLE entity_name_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_entity_name_drops_created ON entity_name_drops(created_at DESC);
CREATE INDEX idx_entity_name_drops_reason ON entity_name_drops(reason, created_at DESC);
