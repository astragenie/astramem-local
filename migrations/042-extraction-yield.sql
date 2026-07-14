-- 042: per-distill-job extraction yield log (ADR-015 headline finding).
--
-- A well-formed `{"atoms":[]}` extraction completes as SUCCESS at every
-- layer -- not the Zod gate, not the job queue, not the poison counter
-- (which only increments on failure, and a zero-atom success never fails).
-- A broken model and a genuinely empty transcript are indistinguishable.
-- This table is the only place that distinction becomes observable: one
-- row per distill job recording how many chunks went in and how many
-- atoms came out, so the doctor "Extraction yield" canary can compute a
-- zero-yield RATE over a recent window instead of relying on existence
-- (canary-must-measure-rate-not-existence -- entity extraction was 87%
-- broken for weeks behind a green existence-check before that lesson).
--
-- Same discipline as relation_guard_drops (migration 029) / entity_link_
-- drops (migration 036): counts only, never atom/transcript text.
--
-- Written from src/distill/pipeline.ts's runPipeline, in its own try/catch
-- immediately after stage 5 (extract) completes, mirroring the relation-
-- guard-drop write in the same function -- never re-thrown, so a
-- diagnostic write failure can never be mistaken for extraction itself
-- failing.
CREATE TABLE extraction_yield (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NULL,
  chunks_in INTEGER NOT NULL,
  atoms_out INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_extraction_yield_created ON extraction_yield(created_at DESC);
