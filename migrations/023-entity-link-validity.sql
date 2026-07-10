-- 023: fact-level bitemporal validity on memory_entities (FEAT-453 slice 2).
--
-- memory_entities needs a surrogate PK before it can carry a validity window
-- of its own: the existing PK is the composite natural key (memory_id,
-- entity_id) (012-entities.sql), which means "the same fact link reasserted
-- with a different validity window" has nowhere to live as a second row.
-- SQLite has no ALTER TABLE that swaps a PK or converts a composite PK to a
-- surrogate one in place, so this is the same create-copy-swap table-rebuild
-- pattern migrations 013/017/021 already established. memory_entities is a
-- leaf table (nothing holds `REFERENCES memory_entities(...)`), so — unlike
-- migration 017's memories rebuild — there is no FK-cascade-on-DROP hazard
-- to back child rows up around; this is the simpler, migration-021-shaped
-- rebuild.
--
-- valid_at / invalid_at: bitemporal valid-time window for ONE fact link (one
-- memory_id/entity_id association at a point in time), distinct from:
--   - memories.valid_from/valid_to (006) — the MEMORY-level window. A fact
--     link's effective window is always clipped to fall inside its parent
--     memory's window at query time (never wider) — see
--     docs/specs/FEAT-453-bitemporal-design.md §3 for the exact clip.
--   - memory_events.created_at / memories.captured_at — ingest-time
--     bookkeeping, not valid-time.
-- Both nullable, and NEITHER is backfilled for pre-existing rows (unlike
-- migration 006's valid_from backfill): NULL valid_at means "no stated
-- fact-level start" and resolves to the parent memory's own valid_from AT
-- QUERY TIME (§3), not a value copied into the row — so a later correction
-- to the memory's own valid_from doesn't require rewriting every linked
-- fact row. NULL invalid_at means "not known to have stopped being true"
-- (same half-open-interval convention as memories.valid_to). Backfilling
-- either column here would be redundant work producing byte-identical
-- query-time behavior to leaving them NULL.
--
-- UNIQUE(memory_id, entity_id) is deliberately NOT re-added as a constraint:
-- unlike the old composite PK, a memory MAY now carry multiple fact-link
-- rows for the same (memory_id, entity_id) pair with different validity
-- windows (e.g. "Alice was the approver Jan-Mar" then a second row "Alice
-- was the approver Apr-" after a stated correction) — that plurality is the
-- entire point of this migration. Overlapping-window hygiene for the same
-- pair is an application-level invariant (EntityRepo.linkWithValidity's
-- caller controls the window), not a DB constraint — see §1.4 for the
-- partial-unique index that DOES still enforce "at most one currently-open
-- window per pair."
--
-- Zero interaction with vec0 tables: memory_entities has never been part of
-- the memories_vec schema and this migration adds no vec0 table, touches no
-- FLOAT[N] column, and does not go through getVecSchemaDim()/
-- DEFAULT_EMBED_DIM (CLAUDE.md "Do NOT" section).
--
-- migrate.ts wraps each migration in db.transaction() — no explicit
-- BEGIN/COMMIT here.

CREATE TABLE memory_entities_new (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  valid_at INTEGER,
  invalid_at INTEGER
);

-- Explicit column list + synthesized UUIDv4-shaped id per row (same
-- randomblob idiom migration 010 used to backfill memory_events.event_id) —
-- every pre-existing link becomes exactly one row with valid_at/invalid_at
-- both NULL (no stated window yet, falls back to the parent memory's own
-- valid_from per §3 until a distill run or explicit correction sets one).
INSERT INTO memory_entities_new (id, memory_id, entity_id, valid_at, invalid_at)
SELECT
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) ||
    substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  ),
  memory_id, entity_id, NULL, NULL
FROM memory_entities;

DROP INDEX IF EXISTS idx_memory_entities_entity;
DROP TABLE memory_entities;
ALTER TABLE memory_entities_new RENAME TO memory_entities;

-- 1.3: lookups this feature and the pre-existing entity surfaces need.
CREATE INDEX idx_memory_entities_entity ON memory_entities(entity_id);
CREATE INDEX idx_memory_entities_memory ON memory_entities(memory_id);

-- 1.4: "at most one currently-open (invalid_at IS NULL) window per
-- (memory_id, entity_id) pair" — the one invariant worth a DB constraint
-- rather than leaving entirely to the application. A partial unique index
-- (not a full UNIQUE(memory_id, entity_id)) is required specifically
-- because it must NOT reject closed (invalid_at NOT NULL) historical rows
-- for the same pair — those are the whole feature.
CREATE UNIQUE INDEX idx_memory_entities_open_window
  ON memory_entities(memory_id, entity_id)
  WHERE invalid_at IS NULL;
