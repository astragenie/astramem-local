-- 006: Atom v3 (ADR-001) — bitemporal validity, scope, lineage on memories.
-- See docs/adr/ADR-001-canonical-memory-atom.md.
--
-- valid_from/valid_to: bitemporal valid-time window. valid_to NULL = currently
-- valid. New rows set valid_from = created_at at insert time (see
-- src/storage/memories.ts); existing rows are backfilled below.
-- superseded_by: id of the memory that replaced this one. Mutated only via
-- the lifecycle/event-log ops landing in Wave 2b — this migration just adds
-- the column (NULL for all rows).
-- derived_from: JSON array of memory ids — consolidation lineage (ADR-004
-- stage 9). NULL until a consolidation pass sets it.
-- scope: personal | team | org (ADR-009); personal is the default.
--
-- SQLite ALTER TABLE ADD COLUMN cannot add NOT NULL with a non-constant
-- default on existing rows, but a literal constant default (scope) is fine
-- directly on the ALTER. valid_from has no literal default available (it
-- must mirror each row's own created_at), so it is backfilled via a
-- separate UPDATE statement below.

ALTER TABLE memories ADD COLUMN valid_from INTEGER;
ALTER TABLE memories ADD COLUMN valid_to INTEGER;
ALTER TABLE memories ADD COLUMN superseded_by TEXT;
ALTER TABLE memories ADD COLUMN derived_from TEXT;
ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal';

-- Backfill valid_from for pre-existing rows so bitemporal queries are
-- correct from day one.
UPDATE memories SET valid_from = created_at WHERE valid_from IS NULL;
