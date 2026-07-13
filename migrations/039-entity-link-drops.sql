-- 036: entity-link guard-drop counters (issue #200 AC-3).
-- (034/035 reserved by sibling in-flight branches — fix-188-schema-hash and
-- fix-205-validity — not yet merged when this migration was authored.)
--
-- Counts + reasons only -- never entity names or memory text -- same
-- discipline as relation_guard_drops (migration 029, which this table
-- mirrors field-for-field: reason/count/session_id/created_at).
--
-- Written from src/distill/stages/08-embed-index.ts's per-entity
-- upsert+link loop: an individual entity.name -> entities.id resolution or
-- memory_entities write that throws is caught, skipped (the atom and its
-- other entities still persist), and counted here under reason
-- 'link_write_error' -- never allowed to fail the whole distill job (same
-- fail-open posture as the relation guard-drop write in the same file).
--
-- Exists so the doctor "Entity link rate" canary (src/doctor/checks.ts)
-- can tell apart two failure modes that look identical from `memories` /
-- `memory_entities` alone (a memory with zero linked entities, either way):
--   - the model never emitted an entities[] array for that atom (0 rows
--     written, 0 drops -- nothing to distinguish, this is a real zero)
--   - the model emitted entities[] but every write attempt failed (0 rows
--     written, drops > 0 -- a broken zero)
-- issue #200's root cause (num_ctx truncation + a dropped temperature
-- option) was the first failure mode, not this one -- this counter exists
-- so a FUTURE regression at the write-time step doesn't hide behind the
-- same "zero row count" ambiguity relation_guard_drops was built to close
-- for relations.
CREATE TABLE entity_link_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_entity_link_drops_created ON entity_link_drops(created_at DESC);
CREATE INDEX idx_entity_link_drops_reason ON entity_link_drops(reason, created_at DESC);
