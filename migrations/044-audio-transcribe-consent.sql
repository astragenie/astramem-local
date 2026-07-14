-- 044: audio-file transcription capture surface (FEAT-489 Slice A / FEAT-490,
-- ADR-017 decision 6).
--
-- Migration number note (race, expected): this worktree branched from
-- origin/main at 043-embed-cache.sql. origin/main has since gained its own
-- 044 (consolidation-judge-near-threshold), and a sibling parallel wave
-- (L1-4) is independently also claiming 044-046 on its own branch. The
-- "contiguous from 001" invariant (tests/storage/migration-renumber.test.ts)
-- means THIS branch must number sequentially from what it can see on disk
-- (043), so this file is 044 here — it WILL collide at merge time and needs
-- renumbering then. Cheap fix (rename + SCHEMA_VERSION re-derives
-- automatically, see src/storage/schema-version.ts) — not a reason to leave
-- a gap or guess a "safer" number nobody can actually reserve up front.
--
-- Three additive, nullable/new-table changes, no rewrite of an existing row:
--
-- `transcripts.consent_disclosed` / `memories.consent_disclosed` mirror the
-- `capture_source` threading pattern migration 024 established (transcripts
-- row -> distillHandler -> EmbedIndexContext -> stage 8 memories insert).
-- ADR-017 decision 6: the wire contract's `provenance.consent_disclosed`
-- (contracts/schemas/atom.v2.schema.json, FEAT-496, additive/minor, already
-- shipped at contracts v2.3.0) is set by the capturing adapter at the point
-- the operator opted in. astramem-local has no separate live "consent
-- flow" UI gate today (config.yaml hand-edit is this repo's existing
-- opt-in mechanism for every other mode-enum toggle — durabilityGate,
-- contradictionDetection — none of which have an interactive wizard prompt
-- either); the transcribe handler stamps consent_disclosed = 1 on every
-- transcript/memory it produces specifically BECAUSE `audio.mode !== 'off'`
-- is itself the one-and-only opt-in signal this daemon can observe
-- (single-user, local-first — there is no second party's config to
-- distinguish). NULL for every pre-existing row and every other capture
-- source, exactly like capture_source's own NULL default.
--
-- `transcription_guard_drops` mirrors `evidence_guard_drops` (migration 030)
-- field-for-field: counts + a reason label only, never raw segment text.
-- FEAT-490's hallucination/low-confidence filter (src/audio/confidence-filter.ts)
-- writes one row per (reason, count) pair per transcribe job run so dropped
-- segments are visible in stats, never silent, matching evidence-guard-log's
-- rationale for why a guard needs its own drop-counter table rather than
-- being inferred from an absence in `memories`.
ALTER TABLE transcripts ADD COLUMN consent_disclosed INTEGER;
ALTER TABLE memories ADD COLUMN consent_disclosed INTEGER;

CREATE TABLE transcription_guard_drops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  session_id TEXT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_transcription_guard_drops_created ON transcription_guard_drops(created_at DESC);
CREATE INDEX idx_transcription_guard_drops_reason ON transcription_guard_drops(reason, created_at DESC);
