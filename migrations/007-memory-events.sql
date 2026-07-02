-- 007: memory_events append-only log (ADR-002 decision point 1).
-- See docs/adr/ADR-002-local-storage-engine.md.
--
-- Source of truth for state *changes*: create | invalidate | supersede |
-- promote_scope | erase_request | usefulness. Materialized state (the
-- memories table) is updated in the same transaction as the event append —
-- see src/storage/memory-events.ts MemoryEventRepo. This is log + tables in
-- one file, not full event sourcing: no view rebuilding, no projection
-- framework. The log exists so ADR-003 sync becomes log-shipping and audit
-- becomes free.

CREATE TABLE memory_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN ('create', 'invalidate', 'supersede', 'promote_scope', 'erase_request', 'usefulness')),
  atom_id TEXT NOT NULL,
  payload_json TEXT,
  content_hash TEXT,
  created_at INTEGER NOT NULL,
  synced_at INTEGER
);

CREATE INDEX idx_memory_events_atom_seq ON memory_events (atom_id, seq);

-- Backfill: synthetic 'create' events for every pre-existing memory, so the
-- first sync (ADR-003) ships a complete log rather than one with a gap at
-- the start. Hash-stable: content_hash mirrors the memory's own hash column;
-- created_at mirrors the memory's own created_at (not the migration's run
-- time), so replays are consistent with actual atom creation order.
INSERT INTO memory_events (event_type, atom_id, payload_json, content_hash, created_at)
SELECT 'create', id, '{"backfill":true}', hash, created_at FROM memories;
