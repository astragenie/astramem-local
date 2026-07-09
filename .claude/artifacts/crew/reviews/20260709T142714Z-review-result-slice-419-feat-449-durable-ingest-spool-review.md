---
findings: "🔴:0,🟡:2,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-09T14:34:04.523Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: FEAT-449 durable ingest spool is correct and closes the ingest outage; no data-loss path found and the ingest.ts refactor is byte-identical HTTP behavior, but two MEDIUM perf/design notes (synchronous unbounded boot-time drain, dropped D-B6 prepared-statement hoisting on the hot path) warrant a low-risk follow-up.
- Evidence Checked:
  - Diff correctly scoped to origin/main (local main ref was stale at 36477148 vs actual c897c870 — false-positive contracts/atom2 noise excluded from review). Read full diffs of src/server/routes/ingest.ts (411-line diff)
  - src/capture/claude.ts
  - src/ingest/spool.ts
  - src/ingest/spool-drain.ts
  - src/cli/capture.ts/index.ts/serve.ts
  - src/config/config.ts
  - plus all 4 new/changed test files. Ran bun run build (exit 0) after discovering dist/ was stale (built 09:07 before a 09:09 src merge) which caused 2 spurious ingest-e2e failures unrelated to this slice; rebuilt and reran full suite: 173/174 files pass
  - 1984 pass / 14 skip
  - only pre-existing tests/scripts/post-merge-rebuild.test.ts fails (Windows-bun SyntaxError
  - matches brief). Confirmed tests/integration/ingest-e2e.test.ts and src/server/lib/wire-meta.ts are byte-identical to origin/main (git diff empty) — the 59 pre-existing ingest tests are unmodified.
- Files Reviewed:
  - src/server/routes/ingest.ts
  - src/capture/claude.ts (new)
  - src/ingest/spool.ts (new)
  - src/ingest/spool-drain.ts (new)
  - src/cli/capture.ts
  - src/cli/index.ts
  - src/cli/serve.ts
  - src/config/config.ts
  - tests/capture/claude.test.ts (new)
  - tests/cli/capture-claude.test.ts (new)
  - tests/ingest/spool.test.ts (new)
  - tests/ingest/spool-drain.test.ts (new)
- Test Adequacy: New unit/integration coverage is strong and AC-mapped: spool.test.ts covers atomic tmp+rename write/overwrite/quarantine/delete incl. already-vanished races; claude.test.ts covers jsonl parse edge cases (corrupt line, string-vs-block content, missing sessionId fallback) plus idempotency-key stability across differing captured_at; capture-claude.test.ts explicitly asserts AC-3 fail-soft (exactly one console.warn, exitCode=1, no throw, nothing spooled) for both missing-file and missing-arg cases; spool-drain.test.ts covers AC-4/6 (drain+delete+counts), AC-5 (oversize quarantined unread, poison quarantined only after 5 attempts not on first failure), and a genuine AC-7/AC-8 integration test that spools with zero daemon/db constructed, then boots a real worker and asserts a memory_events create row. Ran the full suite locally (1984 pass/14 skip) plus targeted reruns of all touched files.
- Risks: MEDIUM (src/cli/serve.ts:333, boot-pass runSpoolDrain()): the boot-time drain runs synchronously, unbounded, after app.listen() but on the same single-threaded event loop as request handling — a large backlog (the exact scenario this feature exists to fix: 455+ accumulated transcripts were observed in the outage that motivated FEAT-449) would block all HTTP request processing for the duration of the boot pass. Not a correctness or data-loss bug (files aren't deleted until each individual ingestCanonicalTranscript call commits), but an availability/latency concern worth a follow-up (e.g. per-tick file cap, or yielding between files) if a real backlog of that size recurs. MEDIUM (src/server/routes/ingest.ts:182-224 ingestCanonicalTranscript): 7 prepared statements are now prepared fresh on every call (both per-HTTP-request and per-spool-drain-tick) instead of reusing the route factory's already-hoisted equivalents (the D-B6 optimization documented at ingest.ts:307-309, 'All db.prepare() calls happen ONCE per server start, not per request'). The docstring explicitly acknowledges and accepts this trade-off for code-sharing simplicity, and better-sqlite3 prepare cost is genuinely microsecond-scale, so this is unlikely to matter in practice — flagging as a documented, low-urgency deviation from an established local convention rather than a functional defect. No CRITICAL or HIGH findings: the ingestCanonicalTranscript extraction is byte-identical in transaction boundaries, error propagation (sentinel classes replace Object.assign but the route's instanceof checks are equivalent to the old boolean-flag checks), and response shape; no path deletes a spool file without a committed transaction (delete only follows a successful ingestCanonicalTranscript return or an IdempotentReplayError, both of which imply the row already exists); IdempotencyConflictError and unparsable/invalid envelopes quarantine (rename, not delete) so content is always recoverable; the in-memory poison counter resetting on daemon restart is explicitly documented as an accepted trade-off, not silent.
- Required Follow-up: Optional follow-up (non-blocking): cap or yield the boot-time spool drain pass so a large backlog can't stall request handling at startup; consider whether ingestCanonicalTranscript should accept pre-hoisted statements from the caller to restore the D-B6 optimization on the HTTP hot path. Neither blocks merge.

