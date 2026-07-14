-- 048: audio-file transcription capture surface (FEAT-489 Slice A / FEAT-490,
-- ADR-017 decision 6).
--
-- Migration number history (renumbered once, cheap by construction): this
-- worktree originally branched from origin/main at 043-embed-cache.sql and
-- authored this file as 044. By finalize time origin/main had independently
-- claimed 044 (an unrelated in-flight lane, #318) and 045-047 (L1-4, #322,
-- merged as FEAT-495 hardening) -- confirmed via `git merge origin/main`,
-- which pulled all four of those files in cleanly with no conflicts. This
-- file was renamed 044 -> 048 (the next free number on live main at merge
-- time) with no other change -- SCHEMA_VERSION re-derives automatically
-- from the highest migration number on disk (src/storage/schema-version.ts),
-- so no manual version bump was needed. Content below is unchanged from the
-- original 044 draft.
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
