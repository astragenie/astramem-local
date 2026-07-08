-- 021: widen memory_events.event_type CHECK to add 'unsupersede' (FEAT-442
-- reversal primitive — un-supersede/un-hide a memory previously superseded,
-- most commonly to reverse an autonomous-consolidation auto-accept).
--
-- SQLite CHECK constraints are immutable, so widening requires the same
-- create-copy-swap table-rewrite pattern migration 013 used to add
-- 'archive'/'restore'. memory_events has no FK dependents, but DROP TABLE
-- silently drops every index defined on it too, so ALL FIVE indexes this
-- table has accumulated across prior migrations must be recreated below —
-- idx_memory_events_atom_seq (007), the unique event_id index (010,
-- ADR-011), the two usefulness partial indexes (019,
-- idx_memory_events_usefulness_served/used), and the corrections partial
-- index (020, idx_memory_events_correction_type). The INSERT uses an
-- explicit column list (not `SELECT *`) so it doesn't silently depend on
-- ALTER TABLE ADD COLUMN's physical append-at-end ordering (event_id was
-- added that way in migration 010).
--
-- 'unsupersede' is deliberately local-only, like 'archive'/'restore': the
-- sync wire schema (contracts/schemas/sync-envelope.v1.schema.json) is NOT
-- touched by this migration, and src/sync/shipper.ts's exclusion list adds
-- 'unsupersede' alongside 'archive'/'restore' — see that file's doc comment
-- for why (cross-device propagation of a reversal is an explicit follow-up,
-- not solved here).

CREATE TABLE memory_events_new (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(event_type IN (
    'create', 'invalidate', 'supersede', 'promote_scope', 'erase_request',
    'usefulness', 'archive', 'restore', 'unsupersede'
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
