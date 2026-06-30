ALTER TABLE transcripts ADD COLUMN event TEXT;
ALTER TABLE transcripts ADD COLUMN captured_at INTEGER;
ALTER TABLE transcripts ADD COLUMN client_scrub_applied INTEGER;
ALTER TABLE transcripts ADD COLUMN client_scrub_hits INTEGER;
ALTER TABLE transcripts ADD COLUMN client_scrub_version TEXT;
ALTER TABLE transcripts ADD COLUMN client_scrub_hits_by_label_json TEXT;
ALTER TABLE transcripts ADD COLUMN client_version TEXT;
ALTER TABLE transcripts ADD COLUMN wire_version TEXT NOT NULL DEFAULT 'v0.0';

CREATE TABLE ingest_idempotency (
  key TEXT PRIMARY KEY,
  tenant_id TEXT,
  body_hash TEXT NOT NULL,
  summary_memory_id TEXT,
  created_at INTEGER NOT NULL
);
