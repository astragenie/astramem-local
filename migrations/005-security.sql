-- SEC-6: stage-0 secret-redaction counters. Counts + types only per ingest —
-- raw secret values are NEVER written here (see src/redact/). Surfaced via
-- `doctor` and GET /health. See docs/specs/2026-07-02-encryption-and-secret-redaction.md §4.2/§4.3.
CREATE TABLE redaction_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  count INTEGER NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_redaction_log_created ON redaction_log(created_at DESC);
CREATE INDEX idx_redaction_log_type ON redaction_log(type, created_at DESC);
