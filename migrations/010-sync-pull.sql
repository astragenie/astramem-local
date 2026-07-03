-- 010: sync pull — event_id (ADR-011 multi-device conflict policy) +
-- sync_pull_state (FEAT-407 pull watermark).
-- See docs/adr/ADR-011-multi-device-conflict-policy.md.
--
-- Part 1 — event_id on memory_events:
-- Globally-unique per-event identity assigned once at append time. This is
-- the pull-side idempotency key (FEAT-407 AC-2): "INSERT ... WHERE NOT
-- EXISTS (SELECT 1 FROM memory_events WHERE event_id = ?)" per pulled row,
-- and the deterministic tie-break key (created_at, event_id) ADR-011's
-- conflict rules use. Additive on the wire (WireSyncEvent gains event_id,
-- no astramem-sync@1 version bump — ADR-001's additive-field evolution
-- rule) and additive here: existing single-device append()/invalidate()/
-- supersede()/erase() code paths are unaffected other than now also writing
-- event_id.
--
-- SQLite ALTER TABLE ADD COLUMN cannot add NOT NULL with a non-constant
-- default on existing rows (same constraint migration 006 documented), so
-- the column is added nullable, backfilled per-row with a distinct
-- UUIDv4-shaped value (mirrors migration 007's synthetic-value backfill
-- pattern), then uniquely indexed. New rows always supply event_id via
-- MemoryEventRepo.append() (node:crypto randomUUID()) — enforced at the
-- application layer since SQLite can't retrofit a NOT NULL constraint onto
-- an existing column without a full table rebuild.

ALTER TABLE memory_events ADD COLUMN event_id TEXT;

UPDATE memory_events
SET event_id = lower(
  hex(randomblob(4)) || '-' ||
  hex(randomblob(2)) || '-4' ||
  substr(hex(randomblob(2)), 2) || '-' ||
  substr('89ab', 1 + (abs(random()) % 4), 1) ||
  substr(hex(randomblob(2)), 2) || '-' ||
  hex(randomblob(6))
)
WHERE event_id IS NULL;

CREATE UNIQUE INDEX idx_memory_events_event_id ON memory_events (event_id);

-- Part 2 — sync_pull_state: persisted pull cursor/watermark (FEAT-407's own
-- scope, per ADR-011's "Implications for FEAT-407": the merge/dedup
-- mechanics are ADR-011's, persisting where pull left off is FEAT-407's).
-- Single-row table (id=1 enforced) — one pull cursor per daemon install.
-- Persisted, and advanced in the SAME transaction as the dedup-insert +
-- projection recompute it corresponds to, so a daemon restart mid-sync
-- resumes from the last-persisted cursor rather than re-pulling from zero
-- or leaving a gap (AC-4).

CREATE TABLE sync_pull_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  updated_at INTEGER NOT NULL
);
