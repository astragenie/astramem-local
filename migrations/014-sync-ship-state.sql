-- 014: sync_ship_state — persisted last-ship-attempt state (FEAT-434).
--
-- FEAT-427's GET /sync/status can only ever report success/idle because the
-- shipper (src/sync/shipper.ts, ADR-003) only persists `synced_at` on a
-- SUCCESSFUL ship — there is no record of the LAST FAILED attempt, its
-- error, or the current backoff state. This closes that gap.
--
-- Mirrors migration 010's `sync_pull_state` convention exactly: a single-row
-- table (id=1 enforced) updated via INSERT ... ON CONFLICT DO UPDATE, so a
-- daemon restart remembers the last attempt outcome instead of silently
-- resetting to "never shipped"/"up to date" (the same reasoning that made
-- the pull watermark persisted rather than in-memory — the shipper loop's
-- own in-memory `failures` counter in startShipper() does NOT survive a
-- restart, and support/observability should still see the prior failure).
--
-- last_error is captured sanitized + length-capped by the application layer
-- (shipper.ts sanitizeError) BEFORE it ever reaches this table — the device
-- sync token must never be persisted here, since this row is exposed
-- read-only via GET /sync/status.

CREATE TABLE sync_ship_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  last_attempt_at INTEGER,
  last_result TEXT CHECK (last_result IN ('ok', 'error')),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER
);
