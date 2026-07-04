-- 012: entity extraction schema (W4.2, FEAT-402 slice 1).
--
-- entities: canonical named-thing registry. `name` is normalized (lowercase
-- + trim; AC-9 seam — src/entity/normalize.ts normalizeEntityName) so
-- "Postgres"/"postgres"/"  Postgres  " collapse to one row via the UNIQUE
-- constraint (EntityRepo.upsert selects-then-inserts on the normalized
-- name). An alias table ("pg" -> "postgres") is deferred — normalizeEntityName
-- is the single seam callers go through, so adding aliasing later never
-- touches call sites.
--
-- memory_entities: many-to-many link, memory_id -> entity_id, written by the
-- distill-time embed-index stage (same LLM call as atom extraction) and by
-- the one-shot `entity-backfill` CLI command for the pre-existing corpus.
--
-- Cascade (AC-3, zero orphan links):
--   - erase() HARD-deletes the memories row (src/storage/memory-events.ts) —
--     ON DELETE CASCADE on memory_id follows it automatically because
--     foreign_keys=ON is set for every connection (src/storage/db.ts).
--   - supersede() does NOT delete the memories row (bitemporal history is
--     kept for as_of queries) so it cannot rely on FK cascade; it explicitly
--     deletes the old memory's memory_entities rows in the same transaction
--     — a superseded memory's facts should stop counting as "current"
--     evidence for an entity even though the row itself survives for audit.
CREATE TABLE entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL
);

CREATE TABLE memory_entities (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);
