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
-- derived_from/scope; 013 archived/archived_at). migrate.ts wraps each
-- migration in db.transaction() — no explicit BEGIN/COMMIT here.
--
-- FK safety: PRAGMA foreign_keys = OFF is a session-level, out-of-transaction
-- operation and cannot be set inside better-sqlite3's transaction wrapper.
-- Not required here because (a) INSERT INTO memories_new SELECT * FROM
-- memories carries forward only already-valid session_id referents in
-- sessions; (b) memories_vec (vec0) and memory_entities (memory_id FK) have
-- no bearing on this table's own rewrite — memory_entities' FK targets
-- memories(id), which is preserved verbatim (DROP+RENAME keeps the same
-- rowids are NOT guaranteed by SQLite's rename, but `id` — the actual FK
-- target column — is copied byte-for-byte via SELECT *, so no
-- memory_entities row is orphaned).

-- 1. Create new table with widened CHECK (every other column verbatim,
--    in the exact order established by 001-init + 004 + 006 + 013).
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

-- 3. Drop old triggers that reference the old memories table.
DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;

-- 4. Drop old indexes attached to memories (001-init + 013-archival).
DROP INDEX IF EXISTS idx_memories_hash;
DROP INDEX IF EXISTS idx_memories_repo_type;
DROP INDEX IF EXISTS idx_memories_session;
DROP INDEX IF EXISTS idx_memories_archival_candidates;

-- 5. Drop FTS table (FTS5 content= binding references the table by name; it
--    does NOT follow a rename — must drop and recreate).
DROP TABLE IF EXISTS memories_fts;

-- 6. Drop old table and rename new table into place.
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

-- 7. Recreate indexes (verbatim from 001-init.sql + 013-archival.sql).
CREATE UNIQUE INDEX idx_memories_hash ON memories(hash);
CREATE INDEX idx_memories_repo_type ON memories(repo, type, created_at DESC);
CREATE INDEX idx_memories_session ON memories(session_id);
CREATE INDEX idx_memories_archival_candidates ON memories(archived, valid_to, created_at);

-- 8. Recreate FTS5 virtual table (verbatim from 001-init.sql).
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, normalized_text, content='memories', content_rowid='rowid'
);

-- 9. Repopulate FTS from existing rows.
INSERT INTO memories_fts(rowid, text, normalized_text)
  SELECT rowid, text, normalized_text FROM memories;

-- 10. Recreate triggers (verbatim from 001-init.sql).
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

-- memories_vec (vec0) and memory_entities/entities are separate tables with
-- no dependency on memories' own column layout or CHECK constraint —
-- unaffected by this rewrite, left alone.
