-- 050: meeting-caption capture (FEAT-491, ADR-017).
--
-- Number provisional at authoring time (2026-07-14): origin/main had 044-047
-- already claimed (044 by #318, 045-047 by L1-4/PR #322) when this was
-- written; L1-1 has first claim on 048+ by convention and hadn't merged yet.
-- 050 leaves a two-slot buffer for L1-1 — re-verify against `ls migrations/`
-- on origin/main at merge time and renumber if it collides.
--
-- Five additive nullable columns, no table rewrite (same ALTER TABLE ADD
-- COLUMN pattern migration 024/028/043 used) -- NULL on every existing row
-- and on every future row from a write path that isn't the meeting-captions
-- capture source (/remember, Codex/Claude capture, the LLM proxy, the
-- distill pipeline's other producers). Byte-identical to today for all of
-- those -- no existing INSERT statement changes shape or gains a new
-- required value.
--
-- `transcripts.platform` / `transcripts.meeting_id` carry the capture-session
-- metadata from ingest time (see ingestCanonicalTranscript,
-- src/server/routes/ingest.ts) through to the distill job, mirroring how
-- `capture_source` already flows transcripts row -> distillHandler ->
-- EmbedIndexContext (migration 024). `transcripts.consent_disclosed` carries
-- ADR-017 decision 6's server-side consent marker the same way, stored as
-- 0/1/NULL (SQLite has no native boolean) -- NULL means "this envelope never
-- claimed a value" (every non-meeting-captions source), 1 means "the ingest
-- schema's superRefine + runtime config gate already confirmed this was
-- true" (a meeting-captions transcript can never reach this table with 0 or
-- NULL here -- both are hard-rejected before insert).
--
-- `memories.speaker_label` is the atom-evidence-level attribution FEAT-491
-- adds: which turn's speaker (contracts capture-envelope.v1.schema.json
-- turns[].speaker) the distilled atom's evidence excerpt was traced back to
-- (src/distill/attribute-speaker.ts, wired at 08-embed-index.ts). NULL for
-- every atom whose evidence didn't match a labeled turn (including every
-- atom from a source with no speaker labels at all -- the overwhelming
-- majority of rows). This is the storage-side half of contracts'
-- atom.v2.schema.json evidence[].speaker_label (FEAT-496) -- there is no
-- local wire serializer for the structured evidence array yet (evidence
-- stays a flat string column, see contracts/README.md "Evidence
-- reconciliation"), so this column is the durable value a future wire
-- mapper reads, not a live JSON-emission path today.
--
-- `memories.consent_disclosed` mirrors `transcripts.consent_disclosed` onto
-- every atom that transcript produces (same "flows straight through" pattern
-- `capture_source` already uses) -- ADR-017's "consent_disclosed stamped on
-- atoms from this source" requirement.
ALTER TABLE transcripts ADD COLUMN platform TEXT;
ALTER TABLE transcripts ADD COLUMN meeting_id TEXT;
ALTER TABLE transcripts ADD COLUMN consent_disclosed INTEGER;
ALTER TABLE memories ADD COLUMN speaker_label TEXT;
ALTER TABLE memories ADD COLUMN consent_disclosed INTEGER;

-- Partial indexes keep both columns cheap to query without indexing the
-- entire table for values that are NULL on every pre-FEAT-491 row (same
-- rationale migration 024's partial index documents).
CREATE INDEX idx_memories_speaker_label ON memories(speaker_label) WHERE speaker_label IS NOT NULL;
CREATE INDEX idx_memories_consent_disclosed ON memories(consent_disclosed) WHERE consent_disclosed IS NOT NULL;
