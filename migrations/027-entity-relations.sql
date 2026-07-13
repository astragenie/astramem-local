-- 027: entity-to-entity relation triples (FEAT-481).
--
-- Local mirror of the sibling `memory` repo's already-shipped
-- astramemory.entity_relationships (FEAT-285/M9, verified against
-- db/migrations/schema.sql:4556-4575) -- column names (predicate,
-- evidence_memory_id) match cloud's exactly, not the FEAT body's original
-- relation_type/source_memory_id wording, so a future shipper needs no
-- field-name translation. See docs/specs/FEAT-481-design.md §0 for the
-- verified cross-repo shape.
--
-- subject_entity_id/object_entity_id/evidence_memory_id use ON DELETE
-- CASCADE, NOT cloud's ON DELETE RESTRICT (§0.4) -- a deliberate divergence,
-- not an oversight. Cloud never hard-deletes a memory or entity out from
-- under a relationship row (RESTRICT blocks it structurally); this repo's
-- ADR-006 erase_memory tool is an explicit, user-invoked HARD delete
-- (src/storage/memory-events.ts, `foreign_keys=ON` for every connection,
-- src/storage/db.ts) that every other memory-scoped child table already
-- cascades on (memory_entities, 012-entities.sql). Using RESTRICT here
-- would make erase_memory fail with an FK violation the moment any
-- relationship cites the memory being erased -- CASCADE preserves
-- erase_memory's existing all-or-nothing hard-delete contract. subject/
-- object entity CASCADE is likewise consistent with memory_entities'
-- existing FK (012-entities.sql:32) and is dead code in practice either
-- way: EntityRepo has no delete/erase method, so entities are immortal
-- once created (no merge/rename operation exists in this codebase today --
-- entities.name UNIQUE dedups entirely at *creation* time via
-- normalizeEntityName, src/entity/normalize.ts). If an entity-merge FEAT is
-- ever added, CASCADE is the wrong behavior for a *rename* (the row should
-- be repointed, not deleted) -- flagging this now so that future FEAT
-- doesn't get surprised by an implicit cascade wipe.
--
-- No composite UNIQUE(subject_entity_id, predicate, object_entity_id):
-- cloud's own repository doesn't enforce this at the DB layer either
-- (EntityRelationshipRepository.cs UpsertAsync -- a write-time
-- INSERT...WHERE NOT EXISTS guard, not a constraint) because two different
-- source memories independently asserting the same triple is corroborating
-- evidence, not a conflict. EntityRelationRepo.insert() enforces the guard
-- as a single atomic prepared statement (see src/storage/entity-relations.ts).
--
-- valid_from/valid_to: same half-open valid-time convention as
-- memories.valid_from/valid_to (006) and memory_entities.valid_at/invalid_at
-- (023), and matches cloud's own valid_from NOT NULL / valid_to nullable
-- shape exactly. valid_from is always populated at write time (extracted
-- stated date if the source text gave one, else the source memory's own
-- valid_from/captured_at) -- never left NULL.
--
-- source_excerpt is NOT NULL, matching cloud exactly (schema.sql:4563).
--
-- confidence: REAL model-reported value when the extractor emits one,
-- DEFAULT 0.5 otherwise (matches cloud's column default exactly).
--
-- Zero interaction with vec0 tables -- no FLOAT[N] column, no
-- getVecSchemaDim()/DEFAULT_EMBED_DIM touch (CLAUDE.md "Do NOT" section).

CREATE TABLE entity_relations (
  id TEXT PRIMARY KEY,
  subject_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  object_entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  evidence_memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_excerpt TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  invalidated_by TEXT REFERENCES entity_relations(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);

-- Direction lookups (mirrors cloud's ix_entity_relationships_subject/object,
-- EntityRelationshipEntityConfiguration.cs:28-32).
CREATE INDEX idx_entity_relations_subject ON entity_relations(subject_entity_id, predicate);
CREATE INDEX idx_entity_relations_object ON entity_relations(object_entity_id, predicate);

-- Temporal filtering: currently-valid scan is the default read path for
-- both directions (get_entity_related with no as_of).
CREATE INDEX idx_entity_relations_valid_to ON entity_relations(valid_to);

-- Reverse lookup for the source-memory-scoped cascade (supersede()/erase()
-- need "every relation row sourced from memory X" -- same shape
-- unlinkMemory() already needs for memory_entities, entities.ts:127-129).
CREATE INDEX idx_entity_relations_evidence_memory ON entity_relations(evidence_memory_id);
