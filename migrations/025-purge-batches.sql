-- 025: purge-batch reversible soft-delete generation (FEAT-467, ADR-013
-- Decision 4 gate for FEAT-458's proxy capture tier). Design settled in
-- docs/specs/FEAT-458-S1-design.md §1.
--
-- New event_type values 'purge'/'unpurge' widen memory_events.event_type's
-- CHECK constraint via the same create-copy-swap table-rewrite pattern
-- migration 021 used to add 'unsupersede' (SQLite CHECK constraints are
-- immutable). memory_events has no FK dependents, but DROP TABLE silently
-- drops every index defined on it, so all five indexes accumulated across
-- prior migrations (021's own doc comment enumerates them) are recreated
-- identically below. The INSERT uses an explicit column list, not `SELECT
-- *`, for the same reason 021 did.
--
-- `memories.purge_batch_id` (nullable, additive ALTER TABLE ADD COLUMN --
-- same shape as migration 024's `capture_source` addition) is the
-- authoritative "which open purge batch currently hides this atom" marker.
-- restorePurgeBatch()/finalizePurgeBatch() scope their work to
-- `purge_batch_id = ? AND valid_to IS NOT NULL`, so an atom independently
-- touched by any OTHER lifecycle path since the purge (which, given every
-- existing lifecycle method's own valid_to/archived/superseded_by
-- preconditions, can in practice only mean a hard erase() removing the row
-- entirely) naturally drops out of that scope rather than needing a
-- separate "was this the same purge instant" timestamp comparison.
--
-- `purge_batches` is the batch-level audit record FEAT-467 requires — ids /
-- capture_source / count / time-range are answerable without duplicating an
-- ids array (reconstructable from `memory_events WHERE event_type = 'purge'
-- AND json_extract(payload_json, '$.batch_id') = ?`, mirroring how erase()'s
-- tombstone is the sole surviving record of an erased atom's identity today).
--
-- Like 'archive'/'restore'/'unsupersede', 'purge'/'unpurge' are local-only:
-- src/sync/shipper.ts's exclusion list adds them alongside the others.

CREATE TABLE memory_events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'create', 'invalidate', 'supersede', 'promote_scope', 'erase_request',
    'usefulness', 'archive', 'restore', 'unsupersede', 'purge', 'unpurge'
  )),
  atom_id TEXT NOT NULL,
  payload_json TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  synced_at INTEGER,
  event_id TEXT
);

INSERT INTO memory_events_new (seq, event_type, atom_id, payload_json, content_hash, created_at, synced_at, event_id)
SELECT seq, event_type, atom_id, payload_json, content_hash, created_at, synced_at, event_id FROM memory_events;

DROP INDEX IF EXISTS idx_memory_events_atom_seq;
DROP INDEX IF EXISTS idx_memory_events_event_id;
DROP INDEX IF EXISTS idx_memory_events_usefulness_served;
DROP INDEX IF EXISTS idx_memory_events_usefulness_used;
DROP INDEX IF EXISTS idx_memory_events_correction_type;
DROP TABLE memory_events;
ALTER TABLE memory_events_new RENAME TO memory_events;

CREATE INDEX idx_memory_events_atom_seq ON memory_events (atom_id, seq);
CREATE UNIQUE INDEX idx_memory_events_event_id ON memory_events (event_id);
CREATE INDEX idx_memory_events_usefulness_served ON memory_events(created_at, atom_id)
  WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_served';
CREATE INDEX idx_memory_events_usefulness_used ON memory_events(created_at, atom_id)
  WHERE event_type = 'usefulness' AND json_extract(payload_json, '$.family') = 'recall_used';
CREATE INDEX idx_memory_events_correction_type ON memory_events(event_type, created_at DESC, atom_id)
  WHERE event_type IN ('invalidate', 'supersede');

ALTER TABLE memories ADD COLUMN purge_batch_id TEXT;
CREATE INDEX idx_memories_purge_batch ON memories(purge_batch_id) WHERE purge_batch_id IS NOT NULL;

CREATE TABLE purge_batches (
  batch_id TEXT PRIMARY KEY,
  capture_source TEXT NOT NULL,      -- 'auto_capture' | 'proxy'
  requested_at INTEGER NOT NULL,
  restore_deadline_at INTEGER NOT NULL,
  atom_count INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('open', 'restored', 'finalized')),
  finalized_at INTEGER
);
