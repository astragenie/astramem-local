---
findings: "🔴:1,🟡:2,❓:0\n\n[HIGH] `src/storage/memory-events.ts:480-486` (purgeBatch payload) + `src/server/routes/lifecycle.ts:168-173` (GET /memory/:id/history) — AC-6 is not actually satisfied: restore-deadline is not visible via history/why/memory_history.\nRisk: FEAT-467's stated purpose is \"audit completeness\" for the ADR-013 Decision 4 gate — an operator (or the future proxy-disable flow) inspecting an atom's lifecycle via `GET /memory/:id/history`, `GET /memory/:id/why`, or the MCP `memory_history`/`why_memory` tools sees only `{batch_id, capture_source}` on the `purge` event. The restore-deadline lives exclusively in the `purge_batches` SQLite table, which has no exposed REST route or MCP tool to query by batch_id — so a caller literally cannot answer \"when will this be permanently gone\" from any of the three surfaces AC-6 names, only via raw SQL access to the daemon's local DB file. The handoff's AC self-check claims AC-6 \"PASS — no code change needed, payload pass-through verified by test,\" but tests/server/capture-purge.test.ts:104-131 itself documents the gap in its own comments (\"Restore-deadline lives on the batch row (joinable by batch_id) — not duplicated onto every atom's payload\") and falls back to `db.prepare('SELECT restore_deadline_at FROM purge_batches ...')` — i.e. the test proves the claim is not literally true rather than proving it is.\nFix: add `restore_deadline_at` into the `purge` event's payload in `purgeBatch()` (memory-events.ts:480-486) — `restoreDeadlineAt` is already computed a few lines earlier in the same method, so this is a one-line, non-breaking addition (no migration/schema change, payload_json is free-form JSON) — and update the two capture-purge.test.ts assertions (lines ~123 and ~130) to assert the deadline is present on the payload directly rather than joining purge_batches. This is isolated and low-risk; it does not touch the transaction/atomicity logic reviewed separately as correct.\n\n[LOW] `src/cli/capture.ts` (runAutoCaptureDisable --json output) — the `--json` shape changed from `{erased, already_gone, failed}` to `{purged, batch_id}` with no compatibility note; any external script scraping the old shape silently breaks. Not a documented wire contract, so not blocking, but worth a CHANGELOG/release-notes mention.\n\n[LOW] `tests/server/lifecycle.test.ts:525` \"lifecycle error-status conformance (FEAT-435)\" suite (explicitly designed so \"a future 5th verb can't silently diverge\") was not extended to the new capture-purge verbs. `tests/server/capture-purge.test.ts` does cover the same 401/404/409 matrix independently, so there's no actual coverage gap, just a missed opportunity to keep the single shared conformance suite as the one source of truth."
status: completed
decision: approved_with_notes
author_id: crew:fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-12T16:20:45.778Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Purge-batch primitive is correctly built to spec on the mechanics that matter most (migration index preservation, transaction atomicity/savepoint nesting, capture_source non-branching, exhaustive error-edge-case coverage) — all independently re-verified, not just trusted. One HIGH finding: AC-6 (restore-deadline visible via history/why/memory_history) is not actually satisfied by the shipped code, despite the handoff's self-check claiming PASS; the fix is a one-line, isolated payload addition.
- Evidence Checked:
  - - Re-ran full suite independently: 210 files
  - 2510 passed
  - 6 skipped
  - 0 failed (matches builder's reported numbers exactly). `bun run build` clean.
- migrations/025-purge-batches.sql: confirmed all 5 pre-existing memory_events indexes (idx_memory_events_atom_seq
  - idx_memory_events_event_id unique
  - usefulness_served
  - usefulness_used
  - correction_type) are reproduced identically to migration 021's own precedent; confirmed no migration between 021 and 025 added any index this one would need to also preserve.
- purgeBatch/restorePurgeBatch/finalizePurgeBatch (src/storage/memory-events.ts:466-595): all three wrap in `this.db.transaction()`; finalizePurgeBatch's per-atom `this.erase(id
  - ...)` calls are themselves `this.db.transaction()` calls — confirmed this repo's DB layer is better-sqlite3-multiple-ciphers (src/storage/db.ts:2
  - 5)
  - whose `.transaction()` wrapper correctly nests via SAVEPOINT when already inside a transaction
  - so atomicity holds.
- AC-5 (capture_source no branching): grepped memory-events.ts and capture-purge.ts — the only capture_source-shaped logic anywhere is the CLI's/route's own scoping SELECT (the caller)
  - never inside purgeBatch/restorePurgeBatch/finalizePurgeBatch. Confirmed by direct read
  - matches handoff claim.
- AC-6 (history/why/memory_history surfaces): read src/server/routes/lifecycle.ts:168-173 (GET /memory/:id/history) and src/server/routes/why.ts — both pass memory_events rows through unchanged with no join to purge_batches. tests/server/capture-purge.test.ts:104-131 itself documents restore_deadline_at is "not duplicated onto every atom's payload" and reads it via raw `db.prepare(...)` SQL instead of any HTTP/MCP response — confirming no caller-reachable surface exposes the restore-deadline today.
- Edge cases (unknown id
  - double-restore
  - double-finalize
  - restore-after-finalize
  - finalize-after-restore
  - stale-window restore) are each explicitly tested in tests/storage/memory-events.test.ts and tests/server/capture-purge.test.ts and I confirmed the assertions match the thrown error types (PurgeBatchNotFoundError / MemoryConflictError) by reading the implementation.
- capture.ts retrofit (CLI pre-check count vs. route's own re-query): confirmed the design — a race only ever shrinks what the route purges
  - no double-purge/crash risk — matches the handoff's own risk note.
- Files Reviewed:
  - migrations/025-purge-batches.sql
  - src/storage/memory-events.ts
  - src/server/routes/capture-purge.ts
  - src/server/routes/lifecycle.ts
  - src/server/app.ts
  - src/config/config.ts
  - src/config/writer.ts
  - src/cli/capture.ts
  - src/sync/shipper.ts
  - src/server/lib/wire-meta.ts
  - tests/storage/memory-events.test.ts
  - tests/server/capture-purge.test.ts
  - tests/storage/migrate.test.ts
  - tests/config/writer.test.ts
  - tests/server/version.test.ts
  - tests/integration/ingest-e2e.test.ts
  - tests/storage/atom-v3.test.ts
  - tests/storage/entities.test.ts
  - tests/storage/entity-validity.test.ts
  - tests/storage/upgrade-path.test.ts
- Test Adequacy: 41 new tests (23 storage + 18 route) independently re-run and confirmed green, covering AC-1 through AC-5 including every requested edge case (unknown id, double-restore, double-finalize, restore-after-finalize, finalize-after-restore, stale-window restore, unrelated-change isolation); AC-6's own test inadvertently proves the claimed surface does not actually expose restore-deadline (see findings).
- Author: crew:fullstack-dev
- Judge: crew:reviewer
- Risks: AC-6 gap means an operator cannot currently see a purge batch's restore-deadline through any callable surface (history/why/MCP) -- only batch_id is visible. No scheduled sweep exists yet for finalizePurgeBatch (explicitly deferred to S2 per design doc, not a gap in this FEAT's own scope). CLI --json output shape changed with no compat note (low risk, undocumented contract).
- Required Follow-up: Add restore_deadline_at to the purge event payload in purgeBatch() (memory-events.ts, one-line addition -- restoreDeadlineAt is already computed in scope) so AC-6 is literally satisfied, and update capture-purge.test.ts's AC-6 assertions accordingly. Optional follow-ups: extend the lifecycle error-status conformance suite to cover the 3 new capture-purge verbs; mention the CLI --json shape change in release notes.

