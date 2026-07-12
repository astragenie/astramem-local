---
feature: FEAT-467
title: purge-batch reversible soft-delete primitive
worktree: C:\work\mega\astramemory-local-worktrees\w467
branch: feat/w467-wave1
status: build-complete
---

## Objective

Build the reversible purge-batch primitive that closes ADR-013 Decision 4's
gate on FEAT-458 (LLM proxy auto-capture): `disable → purge` must be
reversible for a bounded window with a durable batch-level audit record,
never an immediate irreversible `erase()`. Design source of truth:
`docs/specs/FEAT-458-S1-design.md` §1.

## What changed

- `migrations/025-purge-batches.sql` — create-copy-swap widening of
  `memory_events.event_type` CHECK to add `'purge'`/`'unpurge'` (same pattern
  migration 021 used for `'unsupersede'`), plus additive nullable
  `memories.purge_batch_id` + partial index, plus new `purge_batches` audit
  table (`batch_id, capture_source, requested_at, restore_deadline_at,
  atom_count, status, finalized_at`).
- `src/server/lib/wire-meta.ts` — `SCHEMA_VERSION` 24 → 25.
- `src/storage/memory-events.ts` — `'purge'`/`'unpurge'` added to
  `MemoryEventType`; new `PurgeBatchNotFoundError` (subclasses
  `MemoryNotFoundError` so `mapLifecycleError` needs no new branch); three new
  `MemoryEventRepo` methods:
  - `purgeBatch(atomIds, captureSource, restoreWindowDays)` — soft-invalidates
    matching atoms via `'purge'` events (never `'invalidate'`), skips
    already-invalid/unknown ids, opens one `purge_batches` row.
  - `restorePurgeBatch(batchId)` — un-hides everything still marked
    `purge_batch_id = batchId AND valid_to IS NOT NULL` within the window;
    404/409 on unknown/already-resolved/window-elapsed.
  - `finalizePurgeBatch(batchId)` — hard-erases the same scoped set via the
    existing, unmodified `erase()`; callable early (operator override) or
    post-window (sweep); 404/409 on unknown/already-resolved.
- `src/server/routes/capture-purge.ts` (new) — `POST /capture/purge`,
  `POST /capture/purge/:batchId/restore`, `POST /capture/purge/:batchId/finalize`,
  reusing `mapLifecycleError` (now exported from `lifecycle.ts`) for identical
  404/409 mapping. Registered in `src/server/app.ts`.
- `src/config/config.ts` / `src/config/writer.ts` — new
  `capture.purge.restoreWindowDays` (default 30), wired into `defaultConfig()`
  and `configToYaml` per the FEAT-461 lesson (never silently dropped).
- `src/cli/capture.ts` — `runAutoCaptureDisable`'s `--purge` path now calls
  `POST /capture/purge` (reversible) instead of looping `DELETE /memory/:id`
  (irreversible); user-facing confirm/log text updated to describe the
  bounded restore window.
- `src/sync/shipper.ts` — `'purge'`/`'unpurge'` added to the local-only
  exclusion list alongside `'archive'/'restore'/'unsupersede'` (same
  scope-decision rationale: cross-device propagation is a follow-up, not
  solved here).
- AC-6 (batch id + restore-deadline visible on lifecycle history) required
  **no route/MCP code change** — `GET /memory/:id/history`, `why_memory`, and
  `memory_history` all pass `memory_events` rows through unchanged, so the
  `purge` event's `{ batch_id, capture_source }` payload is already visible;
  `restore_deadline_at` is joinable via `purge_batches.batch_id`. Verified by
  test, not assumed.

## Tests

- `tests/storage/memory-events.test.ts` — new `purgeBatch` /
  `restorePurgeBatch` / `finalizePurgeBatch` describe block (23 new tests):
  AC-1 (batch open + audit record, never `invalidate`), AC-2 (restore +
  "untouched by unrelated change" via a simulated concurrent `erase()`),
  AC-3/AC-4 (finalize hard-erase, row+FTS gone, tombstone+replay-filter),
  AC-5 (`'proxy'` capture_source works identically), AC-6 (payload shape).
- `tests/server/capture-purge.test.ts` (new, 18 tests) — full REST surface:
  happy path, 400/401/404/409 matrix, AC-4 end-to-end for both outcomes
  (search-visibility before/during/after purge+restore, and
  purge+finalize-with-backdated-deadline leaving the atom permanently gone
  including FTS), AC-6 via `GET /memory/:id/history` and `GET /memory/:id/why`.
- Updated pre-existing `SCHEMA_VERSION`/schema-version assertions (24 → 25)
  in `tests/storage/migrate.test.ts`, `tests/server/version.test.ts`,
  `tests/integration/ingest-e2e.test.ts`, `tests/storage/atom-v3.test.ts`,
  `tests/storage/entities.test.ts`, `tests/storage/entity-validity.test.ts`,
  `tests/storage/upgrade-path.test.ts` — same bump every prior migration in
  this series required.
- Updated `tests/config/writer.test.ts`'s exhaustive-fixture Config object to
  include `capture.purge.restoreWindowDays` (that test's whole job is
  catching an unwired field — it caught the gap correctly).

Full suite: `npx vitest run` → **210 files, 2510 passed, 6 skipped, 0
failed** (includes the two tests CLAUDE.md flags as historically flaky under
load — both passed clean this run). `bun run build` (tsc -p .) clean.

## AC self-check

- AC-1 (batch open, `purge` event never `invalidate`, audit record): PASS —
  `purgeBatch()` + tests.
- AC-2 (restore within window, unrelated-change atoms untouched, batch →
  `restored`): PASS — `restorePurgeBatch()` + tests (including the
  independently-erased-atom case).
- AC-3 (finalize hard-erases via unmodified `erase()`, batch → `finalized`):
  PASS — `finalizePurgeBatch()` + tests.
- AC-4 (both outcomes verified end to end): PASS —
  `tests/server/capture-purge.test.ts`'s two AC-4 describe-block tests drive
  real HTTP calls and assert on search visibility + row/FTS state, not just
  return values.
- AC-5 (capture_source is a plain parameter, no branching): PASS — grepped
  the primitive and route file; the only `capture_source`-shaped logic is the
  CLI's own scoping query (`WHERE capture_source = 'auto_capture'`), which is
  the caller, not the primitive. Verified `'proxy'` end to end in both test
  files.
- AC-6 (batch id + restore-deadline visible on history/why/memory_history):
  PASS — no code change needed, payload pass-through verified by test.

## Risks / open items

- `finalizePurgeBatch`'s "scheduled sweep" trigger mechanism (cron-like tick
  vs. lazy check) is explicitly deferred to an S2 build slice per the design
  doc — this FEAT ships the callable primitive + explicit-call route only. No
  automatic sweep exists yet; an unrestored batch stays `open` (and
  soft-hidden) forever unless something calls `finalize`.
- `runAutoCaptureDisable`'s pre-existing "how many found" prompt still runs
  its own `SELECT ... WHERE capture_source = 'auto_capture' AND valid_to IS
  NULL` query before the user confirms; the actual purge re-derives the same
  set server-side at call time. A window between the two (another process
  purging/erasing concurrently) would only ever shrink what the second query
  purges — no double-purge/crash risk, just a slightly stale count in the
  confirm prompt, matching pre-existing behavior.
- Did not touch MCP tool surface (`erase_memory`/`invalidate_memory`) to add
  purge/restore/finalize MCP tools — the design doc's "Route/CLI surface"
  section only specifies the three REST routes; no MCP tool was requested by
  the ACs and none was added, keeping scope to what was assigned.
