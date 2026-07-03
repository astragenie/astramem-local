-- 013: memory TTL / archival tiers (FEAT-404, W4.4).
--
-- Additive: `memories.archived` + `memories.archived_at` track archival
-- state (default off / null on every existing row). Archival reuses the
-- exact non-destructive bookkeeping supersede()/invalidate() already
-- established (migration 006/007): valid_to is set, no row is ever
-- deleted, and the transition is restorable — see
-- src/storage/memory-events.ts MemoryEventRepo.archive/restore. Because
-- archived memories get valid_to set, every existing `valid_to IS NULL`
-- candidate filter (search.ts, recall/pack.ts) already excludes them for
-- free; restore() clearing valid_to re-admits them for free too.
--
-- The memory_events.event_type CHECK constraint (migration 007) enumerates
-- valid event types; SQLite CHECK constraints are immutable (see migration
-- 003's create-copy-swap precedent), so widening it to add 'archive' and
-- 'restore' requires the same table-rewrite pattern. memory_events has no
-- FK dependents; it has two indexes (atom_seq from 007, the unique
-- event_id index from 010 ADR-011) and gained `event_id` via ALTER TABLE
-- ADD COLUMN in migration 010 — both are carried through explicitly below
-- (an explicit column list on the INSERT, not `SELECT *`, so this doesn't
-- silently depend on ADD COLUMN's physical append-at-end ordering).

ALTER TABLE memories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN archived_at INTEGER;

-- Serves the archival pass's candidate-selection query (archived = 0 AND
-- valid_to IS NULL AND created_at < cutoff).
CREATE INDEX idx_memories_archival_candidates ON memories(archived, valid_to, created_at);

CREATE TABLE memory_events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN ('create', 'invalidate', 'supersede', 'promote_scope', 'erase_request', 'usefulness', 'archive', 'restore')),
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
DROP TABLE memory_events;
ALTER TABLE memory_events_new RENAME TO memory_events;

CREATE INDEX idx_memory_events_atom_seq ON memory_events (atom_id, seq);
CREATE UNIQUE INDEX idx_memory_events_event_id ON memory_events (event_id);
