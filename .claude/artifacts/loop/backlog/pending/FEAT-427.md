---
id: FEAT-427
status: pending
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: []
slices: []
derived_from: null
tags: [concern:sync, concern:observability, surface:api]
autonomous_safe: null
triage_notes: "Small observability gap: the shipper (ADR-003) and puller (ADR-011) maintain sync state locally (memory_events.synced_at, sync_pull_state cursor, sync.json/Config.sync), but nothing surfaces it for a human or a support workflow to inspect. Read-only route, no sync-behavior change."
---

# FEAT-427: GET /sync/status observability route

## Problem — no way to inspect local sync state

The local→cloud shipper (`src/sync/shipper.ts`, ADR-003) and the cloud→local
puller (`src/sync/puller.ts`, ADR-011) both maintain durable local state:

- shipper: `memory_events.synced_at` (per-event ship marker), the implicit
  push cursor (`lastAckedSeq` — highest acked `seq`), and eligibility
  (ADR-009 scope filter: only `team`/`org` atoms ship).
- puller: `sync_pull_state.cursor` (opaque resume watermark, FEAT-407/ADR-011).
- config: `sync.json` / `Config.sync` (`enabled`, `url`, `workspaceId`,
  `batchSize`, `intervalMs`) — the device token itself lives in the OS
  keystore, never here.

None of this is queryable today. A user or support engineer debugging "is
sync working?" has to read SQLite directly. `/health` doesn't cover it either
— it's daemon liveness, not sync state.

## Requested capability

Add `GET /sync/status` (Bearer-gated, like every route except
`/health`/`/version`/`/dashboard` — this one reveals workspace config so it
does not join the public exemption list) returning, from **existing local
state only** (no live SaaS reachability required):

- `enabled` — whether sync is turned on (`Config.sync.enabled`).
- `apiUrl` / `workspaceId` — the configured cloud endpoint + workspace
  (`Config.sync.url` / `workspaceId`). **Never** the device sync token/api
  key — that must not appear in the response body under any field name.
- `last_ship` — timestamp of the most recently shipped event
  (`MAX(memory_events.synced_at)`) plus a derived status
  (`disabled` / `never_shipped` / `up_to_date` / `pending`) computed from
  whether anything is currently outstanding.
- `pending_count` — count of currently ship-eligible, not-yet-synced events
  (same ADR-009 scope-filter predicate `listUnsynced` already uses).
- `cursor` — `push_seq` (shipper's last acked `seq`) and `pull_watermark`
  (puller's persisted resume token, `sync_pull_state.cursor`).

This is explicitly **read-only observability** — it must not alter shipping
cadence, retry/backoff behavior, or pull scheduling in any way, and must
return a coherent response with the daemon fully offline from the cloud
(everything it reads is local).

## Acceptance criteria

- Given `sync.enabled = false`, When `GET /sync/status` is called, Then it
  returns `enabled: false`, `last_ship.status: "disabled"`, and
  `pending_count` reflecting the real local backlog (not forced to zero).
- Given `sync.enabled = true` with unshipped team/org-scoped events, When
  `GET /sync/status` is called, Then `pending_count` matches the ADR-009
  scope-filtered unsynced count and personal-scoped events are excluded.
- Given at least one event has been marked `synced_at`, When
  `GET /sync/status` is called, Then `last_ship.at` equals that timestamp and
  `last_ship.status` is `"up_to_date"` once the backlog is drained.
- Given any of the above states, When the response body is inspected, Then
  no device token / api key / `Authorization` value appears anywhere in it.
- `GET /sync/status` without a valid Bearer token returns 401, matching every
  other non-public route.

## Refs

- ADR-003 (`docs/adr/ADR-003-sync-protocol.md`) — shipper/push protocol.
- ADR-011 (`docs/adr/ADR-011-multi-device-conflict-policy.md`) — puller/pull
  merge + watermark.
- `src/sync/shipper.ts` (`listUnsynced`, `lastAckedSeq`), `src/sync/puller.ts`
  (`getPullWatermark`), `src/config/config.ts` (`Config.sync`),
  `src/config/sync-settings.ts` (`sync.json`).
