CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  repo TEXT,
  project TEXT,
  branch TEXT,
  agent TEXT,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE INDEX idx_sessions_repo_started ON sessions(repo, started_at DESC);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  ts INTEGER NOT NULL,
  kind TEXT
);
CREATE INDEX idx_messages_session ON messages(session_id, ts);

CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX idx_transcripts_session ON transcripts(session_id);

CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK(type IN ('decision','fact','lesson','command','todo')),
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
CREATE UNIQUE INDEX idx_memories_hash ON memories(hash);
CREATE INDEX idx_memories_repo_type ON memories(repo, type, created_at DESC);
CREATE INDEX idx_memories_session ON memories(session_id);

CREATE VIRTUAL TABLE memories_fts USING fts5(
  text, normalized_text, content='memories', content_rowid='rowid'
);

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

CREATE VIRTUAL TABLE memories_vec USING vec0(embedding FLOAT[1024]);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','running','completed','failed','poison','paused')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_jobs_state ON jobs(state, created_at);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content_path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE provider_state (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  dim INTEGER,
  last_health_ok INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  PRIMARY KEY (provider, model)
);

CREATE TABLE budget_spend (
  day TEXT PRIMARY KEY,
  usd_total REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0
);
