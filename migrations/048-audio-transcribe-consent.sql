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
-- the operator opted in. The transcribe handler stamps consent_disclosed = 1
-- on every transcript AND memory it produces (memories threading fixed
-- post-review 2026-07-14 -- an earlier version of this migration promised
-- this for memories but the handler never actually wrote the column; see
-- src/distill/pipeline.ts / src/distill/stages/08-embed-index.ts /
-- src/pipeline/handlers/distill.ts for the fix). NULL for every pre-existing
-- row and every other capture source, exactly like capture_source's own
-- NULL default.
--
-- v1 disclosure surface (also post-review 2026-07-14, see
-- Config['audio']'s doc comment for the full reasoning): ADR-017 decision 3
-- asks for the disclosure copy to live in astramem-local's `init` wizard.
-- `audio.mode`/`audio.disclosureAcknowledged` are NOT collected by
-- `gatherInteractive` -- config.yaml hand-edit is this repo's opt-in
-- mechanism for this toggle, same as every other mode-enum field
-- (durabilityGate, contradictionDetection). Rather than a wizard prompt, the
-- transcribe handler REFUSES to run at all (embedding the full canonical
-- disclosure copy in the error) unless `audio.disclosureAcknowledged` is
-- explicitly `true` -- so `consent_disclosed = 1` above is stamped only once
-- that enforceable gate has already passed, not merely because `mode` is
-- non-'off'. The interactive wizard prompt ADR-017 literally describes
-- remains a valid v2 upgrade (nicer UX over the same underlying gate), not
-- built in this migration.
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
