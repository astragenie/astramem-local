# FEAT-467 Review — purge-batch reversible soft-delete primitive

**Reviewer:** independent review agent · **Date:** 2026-07-12
**Branch:** feat/w467-wave1 · **Commit:** b34eac3 · **Worktree:** w467
**Contract:** `.claude/artifacts/loop/backlog/triaged/FEAT-467.md` (AC-1..AC-6)
**Design:** `docs/specs/FEAT-458-S1-design.md` §1
**Verdict: needs_fix — 1 MEDIUM (AC-6 gap), everything else PASS**

## Verification performed

- `bun run build` — clean, no tsc errors.
- `npx vitest run` — **210 test files / 2510 tests passed, 6 skipped**, full suite, no failures.
- Read every changed file in the diff (21 files); traced all four lifecycle preconditions
  (`invalidate`/`supersede`/`archive`/`restore`/`unsupersede`) to confirm the "purged atom can't
  be independently touched" claim structurally, not just by test count.
- Confirmed the Bearer auth hook (`src/server/app.ts:113-128`) has no path exemption for
  `/capture/purge*` — it's a global `preHandler`, registered before route registration, no
  `/dashboard`/`/health`/`/version`-style carve-out applies.
- Confirmed `valid_to IS NULL` (or the `as_of` variant) is the single shared predicate in both
  `src/search/search.ts` (vector + FTS) and `src/recall/pack.ts` — purge reuses this column, so
  it's excluded from every existing query surface with no new filter to drift.

## Migration 025 — byte-level comparison against 021's pattern

Matches 021's create-copy-swap shape exactly: explicit column list on the `INSERT INTO ...
SELECT` (not `SELECT *`), all five pre-existing indexes on `memory_events` dropped and recreated
identically (verified against the current schema, not just the migration's own comment), no
FK dependents to worry about. `memories.purge_batch_id` and `purge_batches` are additive
(`ALTER TABLE ADD COLUMN` / `CREATE TABLE`), not part of the rewritten table. Partial index
`idx_memories_purge_batch ON memories(purge_batch_id) WHERE purge_batch_id IS NOT NULL` is
correctly scoped (mirrors 024's `capture_source` partial index). No hand-touch of `memories_vec`
anywhere in the migration or in `purgeBatch`/`restorePurgeBatch` — `finalizePurgeBatch` only
touches the vector table via the existing unmodified `erase()`. Rollback story: same as every
other create-copy-swap migration in this repo (forward-only; no down-migration convention exists
elsewhere either, so no gap introduced here specifically).

## Lifecycle races (AC-2) — verified structurally, not just by test

Traced every other lifecycle method's own precondition:

- `invalidate()` (`memory-events.ts:224`), `supersede()` (`:284`), `archive()` (`:344`) all throw
  `MemoryConflictError` if `valid_to !== null` — none can touch an atom `purgeBatch` already
  invalidated.
- `restore()` (`:373`) requires `archived === 1`; `unsupersede()` (`:421-425`) requires
  `archived !== 1` AND `superseded_by !== null`. A purge never sets `archived` or
  `superseded_by`, so neither reversal primitive can accidentally reactivate a purged atom.
- The **only** operation that can touch a purged-and-not-yet-restored atom is `erase()` (hard
  delete, row disappears entirely) — which is exactly why `restorePurgeBatch`'s scoping query
  (`purge_batch_id = ? AND valid_to IS NOT NULL`) correctly and safely excludes it: the row is
  just gone, not silently reappearing under the wrong state.
- Double-purge (batch A purges, batch B purges the same atom while still purged) is structurally
  impossible: `purgeBatch`'s own per-id precondition is `valid_to IS NULL`, so an atom mid-purge
  is never eligible for a second batch until a restore clears it first. Confirmed by reading the
  code, not assumed.
- `finalizePurgeBatch` idempotency: second call on an already-`finalized` batch throws
  `MemoryConflictError` (not silent no-op) — test-covered
  (`tests/storage/memory-events.test.ts` "finalizing an already-finalized batch"). Restore after
  finalize and finalize after restore are both explicitly test-covered and correctly rejected
  with 409 at the route layer.
- Finalize before the window elapses is explicitly **allowed** (operator override), matching the
  design doc — test-covered ("finalize is callable early").

This is genuinely well-built: the "don't clobber a state changed by something else" guarantee
falls out of the *existing* preconditions on every other lifecycle method, not from new
bespoke-and-therefore-riskier logic in the purge primitive itself.

## capture.ts retrofit / sync exclusion / SCHEMA_VERSION — all consistent

- `runAutoCaptureDisable` now calls `POST /capture/purge` once (not a per-id `DELETE` loop),
  reports `batch_id` + purged count, and the user-facing copy correctly describes the new
  reversible-for-a-window behavior instead of "permanently erase." Old per-id erase loop is
  cleanly removed, not left dead alongside the new path.
- `purge`/`unpurge` added to `src/sync/shipper.ts`'s local-only exclusion list in both
  `listUnsynced` and `countUnsynced` — same precedent as `archive`/`restore`/`unsupersede`.
- `SCHEMA_VERSION` bumped 24→25 consistently: `wire-meta.ts`, `tests/server/version.test.ts`
  (both assertions), `tests/storage/migrate.test.ts` (5 call sites including the drift-guard
  test). No stale `24` reference found in the diff.
- Route auth/validation/error-mapping all reuse existing precedent exactly:
  `restore_window_days` is `z.number().nonnegative().optional()` (0 is intentionally legal — a
  no-grace-period override), errors flow through the now-exported `mapLifecycleError`, and
  `PurgeBatchNotFoundError` subclasses `MemoryNotFoundError` rather than inventing a new
  404-mapping branch.

## Finding

**[MEDIUM] AC-6 not fully satisfied — restore-deadline is not visible on the `purge` event's
payload via any of the AC's own named surfaces.**
`docs/specs/FEAT-458-S1-design.md:91` / `.claude/artifacts/loop/backlog/triaged/FEAT-467.md:91`
(AC-6): *"the batch id and restore-deadline are visible on the `purge` event's payload... When
its lifecycle history is inspected (`GET /memory/:id/history` or the MCP
`memory_history`/`why_memory` tools)."*

The `purge` event's payload is `{ batch_id, capture_source }`
(`src/storage/memory-events.ts` `purgeBatch()`) — no `restore_deadline_at`. `GET
/memory/:id/history` (`src/server/routes/lifecycle.ts:168-172`), `GET /memory/:id/why`, and the
MCP `memory_history`/`why_memory` tools (`src/mcp/server.ts:744-762` and the why-tool handler)
all return `events.listForAtom(id)` unenriched — none of them join `purge_batches`. There is also
no `GET /capture/purge/:batchId` route to look the deadline up separately by batch id.

This is not a discovered accident — both the builder's own code comment
(`memory-events.ts` restorePurgeBatch doc: *"Restore-deadline lives on the batch row (joinable by
batch_id) — not duplicated onto every atom's payload"*) and the test itself
(`tests/server/capture-purge.test.ts` "the purge event is visible via GET /memory/:id/history
with batch id + a restore-deadline **joinable via the batch**") acknowledge the gap and assert
around it — the test checks `restore_deadline_at` by querying `purge_batches` directly via raw
SQL, not through any surface a real caller (a human, a script, an MCP client) could reach.
Practically: someone inspecting `why_memory`/`memory_history` for a purged atom sees `batch_id`
but has no way, from that surface, to learn when the restore window closes.

Two reasonable fixes, either is small:
1. Add `restore_deadline_at` to the `purge` event's payload at write time in `purgeBatch()`
   (denormalized, but the value is fixed at purge time and never changes afterward — no drift
   risk), or
2. Enrich `listForAtom`'s response (or a thin wrapper used only by the history/why routes) to
   join `purge_batches` for `purge`/`unpurge` event rows.

Recommend (1) — it's a one-line addition to the existing payload object, keeps `listForAtom`
generic, and doesn't require the history routes to special-case one event type.

## Verdict

**needs_fix** — one AC (AC-6) is not met as literally specified, self-acknowledged in the
builder's own comments/tests rather than fixed. Everything else (migration correctness, lifecycle
race safety, finalize semantics, search invisibility, capture.ts retrofit, sync exclusion,
SCHEMA_VERSION consistency, auth/validation/error-mapping) verified PASS with evidence, including
a full green test suite (2510/2510) and my own tracing of the four other lifecycle
methods' preconditions to confirm the race-safety claim structurally rather than by test count
alone. The fix is small and localized to `purgeBatch()`'s payload construction — does not require
re-reviewing the migration or the broader primitive.
