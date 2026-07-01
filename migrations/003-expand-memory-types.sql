-- 003: Expand memories.type CHECK to include 'note' + 'event'
-- SQLite table-rewrite pattern (CHECK constraints are immutable).
-- migrate.ts wraps each migration in db.transaction() — no explicit BEGIN/COMMIT here.
--
-- FK safety: PRAGMA foreign_keys = OFF is a session-level, out-of-transaction operation
-- and cannot be set inside better-sqlite3's transaction wrapper. It is not required here
-- because:
--   (a) we INSERT INTO memories_new SELECT * FROM memories — all existing session_id
--       values are already valid referents in sessions;
--   (b) the memories_vec virtual table has no FK dependency on memories.

-- 1. Create new table with expanded CHECK (all other columns verbatim from 001-init.sql)
CREATE TABLE memories_new (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('decision','fact','lesson','command','todo','note','event')),
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
  source_hash TEXT
);

-- 2. Copy all existing rows
INSERT INTO memories_new SELECT * FROM memories;

-- 3. Drop old triggers that reference the old memories table
DROP TRIGGER IF EXISTS memories_ai;
DROP TRIGGER IF EXISTS memories_ad;
DROP TRIGGER IF EXISTS memories_au;

-- 4. Drop old indexes attached to memories
DROP INDEX IF EXISTS idx_memories_hash;
DROP INDEX IF EXISTS idx_memories_repo_type;
DROP INDEX IF EXISTS idx_memories_session;

-- 5. Drop FTS table (FTS5 content= binding references the table by name;
--    it does NOT follow a rename — must drop and recreate)
DROP TABLE IF EXISTS memories_fts;

-- 6. Drop old table and rename new table into place
DROP TABLE memories;
ALTER TABLE memories_new RENAME TO memories;

-- 7. Recreate indexes (verbatim from 001-init.sql)
CREATE UNIQUE INDEX idx_memories_hash ON memories(hash);
CREATE INDEX idx_memories_repo_type ON memories(repo, type, created_at DESC);
CREATE INDEX idx_memories_session ON memories(session_id);

-- 8. Recreate FTS5 virtual table (verbatim from 001-init.sql)
CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, normalized_text, content='memories', content_rowid='rowid'
);

-- 9. Repopulate FTS from existing rows
INSERT INTO memories_fts(rowid, text, normalized_text)
  SELECT rowid, text, normalized_text FROM memories;

-- 10. Recreate triggers (verbatim from 001-init.sql)
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

-- memories_vec is a separate virtual table (vec0) — unaffected by memories rewrite, leave alone.
