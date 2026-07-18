-- 054: ingest gatekeeper skip log + per-job gatekeeper run log (FEAT-548).
--
-- Two tables, mirroring migration 052 (triage_guard_drops/triage_run_log)
-- field-for-field for the same reason:
--
--   gatekeeper_skips -- one row per 'skip' verdict the pre-extraction
--   substantiveness gate (src/distill/gatekeeper.ts) returns for a candidate
--   CHUNK, at its insertion point right after stage 3 (chunk) and before
--   stage 4/5 (compact/extract) ever run (src/distill/pipeline.ts) -- one
--   stage EARLIER than triage_guard_drops' atom-level chokepoint. Carries
--   model/confidence/mode/session_id per row (no memory_id -- there is no
--   memory yet at this point in the pipeline; a skipped chunk never reaches
--   extraction, let alone persistence).
--
--   gatekeeper_run_log -- one row per runPipeline call where the gate
--   actually ran (mode != 'off'), recording chunks_evaluated/chunks_skipped
--   counts. Mirrors triage_run_log/extraction_yield field-for-field: without
--   a TOTAL-evaluated denominator, gatekeeper_skips alone can never answer
--   "what fraction of chunks were skipped" (canary-must-measure-rate-not-
--   existence) -- 5 skips out of 10 evaluated and 5 skips out of 5000
--   evaluated are wildly different signals that look identical as a raw
--   skip count. A future doctor "Ingest gatekeeper" canary reads THIS table
--   for its rate and alarms on a >=95% skip rate (FEAT-548 AC-5) -- a gate
--   that skips almost everything is broken, not efficient.
CREATE TABLE gatekeeper_skips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  confidence REAL NOT NULL,
  mode TEXT NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gatekeeper_skips_created ON gatekeeper_skips(created_at DESC);

CREATE TABLE gatekeeper_run_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NULL,
  chunks_evaluated INTEGER NOT NULL,
  chunks_skipped INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_gatekeeper_run_log_created ON gatekeeper_run_log(created_at DESC);
