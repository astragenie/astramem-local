---
id: FEAT-537
status: pending
priority: P2
category: platform
target_release: post-RC
created: 2026-07-17
depends_on: [FEAT-wave0-instance-lock]
derived_from: "Wave 0 PR #415 — Item 3 (bind-before-migrate) blocked by sync db.prepare at route-registration"
---
# FEAT-537: Lazy ingestRoute statement prep → genuine bind-before-migrate

## Problem

Wave 0 (PR #415) shipped the `healthState.ready` + 503 readiness-gate mechanism but
could NOT deliver literal "bind port before migrate" — `buildApp()` → `ingestRoute()`
calls `db.prepare()` synchronously at route-REGISTRATION time against tables like
`ingest_idempotency`, so `buildApp()` throws against an unmigrated DB. `migrate()` must
currently stay ahead of `app.listen()`. The readiness gate is therefore near-no-op today
(nothing is deferred past listen).

To let the port bind + `/health:starting` answer BEFORE the (potentially slow) migrate —
closing the watchdog-kills-a-still-booting-daemon window durably (the #396/#397 class) —
the route handlers must not prepare statements until first use.

## Requested capability

1. Make `ingestRoute`'s (and any sibling route's) `db.prepare()` calls LAZY — prepare on
   first request, not at registration — so `buildApp()` succeeds against an unmigrated DB.
2. Then reorder `serve.ts`: exclusive-lock acquire → bind port (serve `/health:starting`,
   authed routes 503 via the gate Wave 0 already shipped) → migrate/recover/providers →
   flip `healthState.ready = true`. The mutex (Wave 0) already spans the bind.
3. Statement-prep errors must surface loudly on first request (ADR-015), not silently.

## Acceptance criteria

- AC-1: `buildApp()` no longer throws against a fresh unmigrated DB (test).
- AC-2: `/health` answers `starting` + authed routes 503 while migrate is still running
  (deferred past listen); flip to ready + 200 after migrate completes.
- AC-3: no per-request prep-overhead regression (prepare-once-and-cache, not per-call).
- AC-4: the existing 764 Wave-0 tests + smoke stay green.

## Notes

- The readiness-gate + mutex-spans-bind infra already exist (Wave 0) — this FEAT unblocks
  their actual use. Small, well-bounded.
- Companion one-liner (separate, trivial): `serve.ts`'s periodic doctor call forwards only
  compaction+extraction to the probe loop; wire the other 3 roles (judge/passB/triage) now
  that Wave 1 BYO added the multi-role doctor loop (`checks/index.ts`). Do in whichever PR
  touches serve.ts next.
