-- 024: auto-capture provenance (FEAT-455, ADR-012 decision 4 / spike
-- checklist #4, docs/specs/FEAT-455-spike-results.md).
--
-- Migration number note: 023 is reserved by FEAT-453 (entity-link-validity),
-- which merges to main first — this feature's migration is 024.
--
-- Two additive nullable columns, no table rewrite (same ALTER TABLE ADD
-- COLUMN pattern migration 022 used) -- NULL on every existing row and on
-- every future row from a write path that isn't the new hook-tap
-- auto-capture trigger (/remember, manual hook capture, Codex capture, the
-- distill pipeline's other producers). Byte-identical to today for all of
-- those -- no existing INSERT statement changes shape or gains a new
-- required value.
--
-- `transcripts.capture_source` carries the envelope-level tag from ingest
-- time through to the distill job (mirrors how `captured_at` already flows
-- transcripts row -> distillHandler -> EmbedIndexContext.capturedAtMs, see
-- src/pipeline/handlers/distill.ts) so the async distill pipeline can stamp
-- every atom it produces from an auto-captured transcript with the same
-- provenance, without threading it through any of stages 1-7 individually.
--
-- `memories.capture_source` is the column doctor's WARN-row count query and
-- the disable -> purge scoping query (ADR-012 decision 4) actually read.
-- `'auto_capture'` is the only value the new trigger path ever writes.
--
-- Partial index keeps both queries cheap without indexing the entire table
-- for a column that is NULL on every pre-FEAT-455 row (same rationale
-- migration 020's partial index documents).
ALTER TABLE transcripts ADD COLUMN capture_source TEXT;
ALTER TABLE memories ADD COLUMN capture_source TEXT;

CREATE INDEX idx_memories_capture_source ON memories(capture_source) WHERE capture_source IS NOT NULL;
