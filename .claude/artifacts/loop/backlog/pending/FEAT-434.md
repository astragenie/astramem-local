---
id: FEAT-434
status: done
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: [FEAT-427]
slices: []
derived_from: review-FEAT-427
tags: [concern:sync, concern:observability]
autonomous_safe: null
triage_notes: "FEAT-427's own review flagged a gap: the shipper (src/sync/shipper.ts, ADR-003) persists only synced_at on a SUCCESSFUL ship — there is no record of the LAST FAILED ship attempt, its error, or the current backoff state. So GET /sync/status's last_ship.status can only ever be success/idle, never failing/backing-off. Fix that."
---

# FEAT-434: shipper last-attempt state — surface failing/backing-off in GET /sync/status

## Problem

`src/sync/shipper.ts` (ADR-003) marks `memory_events.synced_at` only when a
batch ships successfully. `startShipper`'s exponential-backoff loop tracks
`failures` purely in-memory (a closure variable), so:

- a daemon restart silently forgets that the shipper was failing/backing off,
- `GET /sync/status` (FEAT-427) derives `last_ship.status` from
  `lastShipAt`/`countUnsynced` alone, so it can only ever report
  `disabled` / `never_shipped` / `up_to_date` / `pending` — never
  "the last attempt errored" or "currently backing off, next retry at T".

A support engineer staring at `/sync/status` while sync is actually failing
sees `pending` (a growing backlog) with no error, no failure count, and no
ETA on the next retry.

## Requested capability (delivered)

- Persist last-ship-ATTEMPT state (every attempt, success or failure) in a
  new single-row table `sync_ship_state` (migration 014), matching the
  existing `sync_pull_state` (migration 010) single-row/id=1
  INSERT-ON-CONFLICT convention — chosen over in-memory-only because the
  puller's cursor uses the same persisted convention and a daemon restart
  should not erase "the shipper was failing" from view.
- Capture per attempt: `last_attempt_at`, `last_result` (`'ok'|'error'`),
  `last_error` (sanitized: device token redacted if present, capped at 500
  chars), `consecutive_failures`, `next_retry_at` (backoff schedule, cleared
  on success).
- `src/sync/shipper.ts`: `recordShipSuccess`, `recordShipFailure`,
  `getShipAttemptState`, `sanitizeShipError` — wired into `startShipper`'s
  `round()` so every scheduled attempt (not just the ones a caller happens to
  inspect) updates the row.
- `GET /sync/status` (`src/server/routes/sync-status.ts`): new sibling
  `last_attempt` block (`{ at, result, error, consecutive_failures,
  next_retry_at }`) alongside the existing `last_ship` block — added
  additively rather than folded into `last_ship` to avoid changing that
  block's shape (FEAT-427's tests assert `last_ship` via `toEqual`).
- Zero change to ship behavior/timing/scope (ADR-003, ADR-009) — this is
  recording + exposing state that already flows through the existing loop.

## Acceptance criteria

- Given the shipper has never run, `GET /sync/status` returns
  `last_attempt: { at: null, result: null, error: null,
  consecutive_failures: 0, next_retry_at: null }`.
- Given a ship round fails, `last_attempt.result` is `'error'`,
  `consecutive_failures` increments, `next_retry_at` reflects the backoff
  schedule, and `last_attempt.error` never contains the device sync token
  (redacted even when the raw error message happened to embed it).
- Given a subsequent ship round succeeds, `last_attempt` resets to
  `{ result: 'ok', error: null, consecutive_failures: 0, next_retry_at: null }`.
- The full response body (including the new field) never contains the
  device token/api key under any field name — the FEAT-427 secret-exclusion
  test is extended to assert this for `last_attempt.error` specifically.
- All 13 pre-existing shipper tests and FEAT-427's `/sync/status` tests
  remain green.

## Delivered

- `migrations/014-sync-ship-state.sql` — new `sync_ship_state` table.
- `src/server/lib/wire-meta.ts` — `SCHEMA_VERSION` bumped 13 -> 14.
- `src/sync/shipper.ts` — `ShipAttemptState`, `sanitizeShipError`,
  `recordShipSuccess`, `recordShipFailure`, `getShipAttemptState`; `round()`
  now records every attempt.
- `src/server/routes/sync-status.ts` — new `last_attempt` block.
- Tests: `tests/sync/shipper.test.ts` (state persistence, sanitization,
  end-to-end failure->success via `startShipper`), `tests/server/sync-status.test.ts`
  (new field + extended secret-exclusion assertion), plus schema-version-count
  updates in `tests/storage/migrate.test.ts`, `tests/storage/atom-v3.test.ts`,
  `tests/storage/entities.test.ts`, `tests/storage/upgrade-path.test.ts`,
  `tests/server/version.test.ts`, `tests/integration/ingest-e2e.test.ts`
  (13 -> 14, mechanical — no behavior asserted by these numbers changed).

## Refs

- ADR-003 (`docs/adr/ADR-003-sync-protocol.md`) — shipper/push protocol.
- FEAT-427 (`GET /sync/status` observability route) — the route this extends.
- `src/sync/shipper.ts`, `src/sync/puller.ts` (`sync_pull_state` convention
  this mirrors), `migrations/010-sync-pull.sql`.
