-- 017: widen memories.type CHECK 7 -> 10 (U4-local #111/#112, ADR D4).
--
-- src/contracts/memory.ts's MEMORY_TYPES union was already widened to the
-- canonical 10-value union shared with `@astragenie/astramem-contracts`
-- (`contracts/schemas/atom.v1.schema.json`) — decision, fact, lesson,
-- command, todo, note, event (local's original 7) plus preference,
-- task_result, summary (cloud-only until now). That widening was
-- deliberately type-level only: the memories.type CHECK constraint
-- (migrations/003-expand-memory-types.sql) still only allowed the original
-- 7, so a real INSERT of preference/task_result/summary (e.g. the MCP
-- `remember` tool's canonical-save-contract widening, or a future sync-pull
-- materializing a cloud-authored atom, src/sync/puller.ts) would throw at
-- the DB layer. This migration closes that gap — local is now conformant
-- with atom.v1.schema.json's `type` enum end to end.
--
-- SQLite table-rewrite pattern (CHECK constraints are immutable) — same
-- shape as migration 003 (the original 5->7 widening) and migration 013's
-- memory_events rewrite, extended to carry every column memories has grown
-- since 003 (004 evidence; 006 valid_from/valid_to/superseded_by/
-- derived_from/scope; 013 archived/archived_at).
--
-- FK cascade hazard (NOT present in 003/013 — both predate migration 012):
-- two tables carry `... REFERENCES memories(id) ON DELETE CASCADE` —
-- `memory_entities` (012-entities.sql) and `dim_migration_progress`
-- (011-embed-dim-migration.sql). SQLite's DROP TABLE works by deleting
-- every row of the table being dropped first, and — per SQLite's own FK
-- docs — that implicit per-row DELETE cascades through ON DELETE CASCADE
-- exactly like an explicit DELETE would when foreign_keys=ON (which is
-- true on every connection here, per db.ts). A naive DROP TABLE memories
-- below would therefore silently wipe every memory_entities and
-- dim_migration_progress row — not a hypothetical, this is what a first
-- version of this migration actually did (caught by
-- tests/storage/upgrade-path.test.ts's fixture-count assertion). The fix:
-- back both child tables up into plain (FK-less) temp tables BEFORE
-- touching memories, restore them once the new memories table exists.
-- PRAGMA foreign_keys=OFF is not an option here — it is a session-level,
-- out-of-transaction pragma and is a no-op inside better-sqlite3's
-- migrate.ts transaction wrapper.
-- migrate.ts wraps each migration in db.transaction() — no explicit
-- BEGIN/COMMIT here.

-- 1. Create new memories table with the widened CHECK (every other column
--    verbatim, in the exact order established by 001-init + 004 + 006 + 013).
CREATE TABLE memories_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('decision','fact','lesson','command','todo','note','event','preference','task_result','summary')),
  text TEXT NOT NULL,
  normalized_text TEXT NOT NULL,
  repo TEXT,
  project TEXT,
  branch TEXT,
  agent TEXT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  importance REAL NOT NULL DEFAULT 0.5,
  confidence REAL NOT NULL DEFAULT 0.5,
  hash TEXT NOT NULL,
  embedding_provider TEXT,
  embedding_model TEXT,
  embedding_dim INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_hash TEXT,
  evidence TEXT,
  valid_from INTEGER,
  valid_to INTEGER,
  superseded_by TEXT,
  derived_from TEXT,
  scope TEXT NOT NULL DEFAULT 'private',
  archived INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER
);

-- 2. Copy all existing rows (explicit column list — do not depend on the
--    physical ADD COLUMN append order across 004/006/013).
INSERT INTO memories_new (
  id, type, text, normalized_text, repo, project, branch, agent, session_id,
  importance, confidence, hash, embedding_provider, embedding_model, embedding_dim,
  created_at, updated_at, source_hash, evidence, valid_from, valid_to,
  superseded_by, derived_from, scope, archived, archived_at
)
SELECT
  id, type, text, normalized_text, repo, project, branch, agent, session_id,
  importance, confidence, hash, embedding_provider, embedding_model, embedding_dim,
  created_at, updated_at, source_hash, evidence, valid_from, valid_to,
  superseded_by, derived_from, scope, archived, archived_at
FROM memories;

-- 3. Back up the two FK-child tables into plain temp tables (no FK, so
--    dropping their real tables next cannot cascade into THEM either).
CREATE TABLE memory_entities_backup_017 AS SELECT * FROM memory_entities;
CREATE TABLE dim_migration_progress_backup_017 AS SELECT * FROM dim_migration_progress;

-- 4. Drop the FK-child tables themselves. Now there are zero rows anywhere
--    referencing memories(id), so dropping memories next cannot cascade.
DROP INDEX IF EXISTS idx_memory_entities_entity;
DROP TABLE memory_entities;
DROP INDEX IF EXISTS idx_dim_migration_progress_target;
DROP TABLE dim_migration_progress;

-- 5. Drop old triggers that reference the old memories table.
DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;

-- 6. Drop old indexes attached to memories (001-init + 013-archival).
DROP INDEX IF EXISTS idx_memories_hash;
DROP INDEX IF EXISTS idx_memories_repo_type;
DROP INDEX IF EXISTS idx_memories_session;
DROP INDEX IF EXISTS idx_memories_archival_candidates;

-- 7. Drop FTS table (FTS5 content= binding references the table by name; it
--    does NOT follow a rename — must drop and recreate).
DROP TABLE IF EXISTS memories_fts;

-- 8. Drop old table (safe now — no referencing rows exist anywhere) and
--    rename the new table into place.
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

-- 9. Recreate indexes (verbatim from 001-init.sql + 013-archival.sql).
CREATE UNIQUE INDEX idx_memories_hash ON memories(hash);
CREATE INDEX idx_memories_repo_type ON memories(repo, type, created_at DESC);
CREATE INDEX idx_memories_session ON memories(session_id);
CREATE INDEX idx_memories_archival_candidates ON memories(archived, valid_to, created_at);

-- 10. Recreate FTS5 virtual table (verbatim from 001-init.sql).
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, normalized_text, content='memories', content_rowid='rowid'
);

-- 11. Repopulate FTS from existing rows.
INSERT INTO memories_fts(rowid, text, normalized_text)
  SELECT rowid, text, normalized_text FROM memories;

-- 12. Recreate triggers (verbatim from 001-init.sql).
CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, text, normalized_text) VALUES (new.rowid, new.text, new.normalized_text);
END;
CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, normalized_text) VALUES('delete', old.rowid, old.text, old.normalized_text);
END;
CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, text, normalized_text) VALUES('delete', old.rowid, old.text, old.normalized_text);
  INSERT INTO memories_fts(rowid, text, normalized_text) VALUES (new.rowid, new.text, new.normalized_text);
END;

-- 13. Recreate memory_entities (verbatim schema from 012-entities.sql) and
--     restore its backed-up rows — every memory_id value is byte-for-byte
--     the same `memories.id` it was before (step 2 copied `id` verbatim),
--     so every restored row satisfies the FK against the new memories table.
CREATE TABLE memory_entities (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  PRIMARY KEY (memory_id, entity_id)
);
INSERT INTO memory_entities SELECT * FROM memory_entities_backup_017;
CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);
DROP TABLE memory_entities_backup_017;

-- 14. Recreate dim_migration_progress (verbatim schema from
--     011-embed-dim-migration.sql) and restore its backed-up rows.
CREATE TABLE dim_migration_progress (
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_dim INTEGER NOT NULL,
  completed_at INTEGER NOT NULL,
  PRIMARY KEY (memory_id, target_dim)
);
INSERT INTO dim_migration_progress SELECT * FROM dim_migration_progress_backup_017;
CREATE INDEX idx_dim_migration_progress_target ON dim_migration_progress(target_dim);
DROP TABLE dim_migration_progress_backup_017;

-- memories_vec is a separate virtual table (vec0) with no FK dependency on
-- memories — unaffected by this rewrite, left alone.
