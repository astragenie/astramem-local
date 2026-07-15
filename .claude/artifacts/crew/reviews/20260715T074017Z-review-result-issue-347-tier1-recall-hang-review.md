---
findings: "🔴:0,🟡:1,❓:2"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-15T07:47:02.843Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Tier-1 fix for issue #347 (live recall/mark_used hang) is correct and safe to merge. The core yield fix (1a) genuinely breaks the synchronous stretch, cannot straddle a merge write, and is proven results-unchanged by test, not just yield-fires. The deadline wrapper (1b) is honest in both code comment and wire response, and is integration-tested end-to-end. Build, typecheck:tests, and the full consolidate+server suites (511/511, 35 files) all pass. One non-blocking documentation gap and two low-risk notes for follow-up.
- Evidence Checked:
  - 1a correctness (src/consolidate/consolidate.ts:569-580): the yield is `await new Promise<void>(resolve => setImmediate(resolve))` — a genuine macrotask yield to libuv
  - not a microtask no-op. It sits at the TOP of the inner pair loop
  - before any per-pair state read/mutation
  - and the counter increments unconditionally (before the `invalidatedThisRun`/vector/threshold `continue`s)
  - matching the doc comment's claim to bound the synchronous stretch "regardless of early continues" — verified directly against the new test asserting exactly 9 yields for 45 pairs at interval 5 (floor(45/5)).

No partial-state hazard: `mergeAsSupersede` (consolidate.ts:275-290) performs its writes inside a single synchronous `db.transaction()` — better-sqlite3 transactions run fully synchronously
  - so a yield point in the outer loop is never reached mid-transaction; a merge either completes fully or hasn't started when the loop yields. `MemoryEventRepo.supersede()` (src/storage/memory-events.ts:300-356) additionally re-reads and validates both atoms' current `valid_to` inside that same transaction and throws `MemoryConflictError` if either was concurrently invalidated — so even a genuine concurrent write landing during a yield window fails loudly instead of corrupting state or double-merging
  - consistent with ADR-015. The two routes newly wrapped this PR (`/recall`
  - `POST /memory/:id/used`) only read or append usefulness events (src/server/routes/lifecycle.ts:175-190
  - src/server/routes/search.ts:256-269) — neither calls supersede/invalidate — so the realistic concurrency surface this fix newly exercises does not intersect the exact hazard `supersede()` guards against.

Results-unchanged is asserted
  - not just yield-fires: tests/consolidate/consolidate.test.ts's third new test ("yielding every single pair produces the same merge outcome as the default interval") runs the same near-duplicate pair through yieldEveryNPairs=default vs =1 and asserts identical winner/loser and similarity to 10 decimal places.

1b honesty: src/server/lib/deadline.ts's module doc comment (lines 1-26) and the actual 504 response body (lines 77-85) both explicitly state the wrapper provides "zero protection against issue #347's confirmed mechanism" and "cannot detect or protect against a full synchronous event-loop stall" — asserted verbatim in tests/server/lib/deadline.test.ts and
  - more importantly
  - integration-tested end-to-end via a real Fastify app.inject() call with a hanging embed provider in tests/server/search.test.ts (not just a unit double).

1b correctness: single `TIMEOUT_MARKER` Symbol declaration (deadline.ts:41) — no redeclaration bug. Timer cleared in `finally` (line 89-91) regardless of outcome. `Promise.race` sentinel avoids collision with a legitimate handler result. A rejection from fn() propagates unchanged (tested at deadline.test.ts:39-46) — the wrapper never swallows a real error.

No ADR-015 regression: only one try/catch exists in the entire diff (withDeadline itself
  - deadline.ts:68)
  - and it never swallows an error — it only distinguishes the timeout-race outcome from a real settle.

Yield cadence sanity: benchmarked 624 setImmediate round-trips (the yield count for a full 500-atom max-size group at the default 200-pair interval) at ~2.1ms total on an idle loop — negligible overhead relative to a multi-hundred-ms+ scan
  - while still bounding the longest synchronous stretch to ~200 cheap cosine computations.

Verification run in the worktree: `bun run build` (tsc -p .) exit 0; `bun run typecheck:tests` (tsc -p tsconfig.tests.json) exit 0; `bunx vitest run tests/consolidate tests/server` — 511 passed
  - 35 files
  - 0 failed.

Gap found: `git log --all -- src/server/lib/deadline.ts` shows a single commit (9d419b4) — this is a fresh file
  - confirming the historical TIMEOUT_MARKER-redeclaration bug mentioned in the review brief does not exist in this diff.

Documentation gap: the commit message and code comments cite "ADR-018" as the authoritative root-cause/decision record in 6+ locations (consolidate.ts
  - deadline.ts
  - lifecycle.ts
  - search.ts
  - both new test files) but no such file exists anywhere in the repo (`find . -iname "*ADR-018*"` returns nothing; docs/adr/ tops out at ADR-017). This is exactly the citation-drift class this repo's own CLAUDE.md warns about
  - just for a whole missing document rather than a stale line number. Non-blocking for this Tier-1 fix (code is correct
  - tests pass) but should be filed as a fast follow so future readers of "see ADR-018" aren't chasing a dead reference.
- Files Reviewed:
  - src/consolidate/consolidate.ts
  - src/server/lib/deadline.ts
  - src/server/routes/lifecycle.ts
  - src/server/routes/search.ts
  - tests/consolidate/consolidate.test.ts
  - tests/server/lib/deadline.test.ts
  - tests/server/search.test.ts
- Test Adequacy: 511/511 tests pass (35 files) including 3 new consolidate-yield tests proving results-unchanged and 2 new deadline-wrapper tests (1 unit + 1 real app.inject integration test) proving the honest 504 path; build + typecheck:tests both exit 0
- Risks: ADR-018 doc referenced but missing (doc-only, non-blocking); deadline wrapper has an untested theoretical double-reply-send edge case if async work is added to a currently-synchronous wrapped handler later; yield-boundary state-preservation across multiple merges in one large group is verified by code reading (mergeAsSupersede is a single synchronous db.transaction) but not directly by a multi-merge test
- Required Follow-up: File/add docs/adr/ADR-018-*.md documenting the #347 root cause and 1a/1b decision split (or fix the 6+ dead citations); optionally strengthen the yield test with a larger multi-merge group; 1c (worker-liveness doctor check) intentionally deferred per commit message, no action needed here

