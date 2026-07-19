---
findings: "🔴:0,🟡:0,❓:0"
status: completed
decision: approved
judge_id: reviewer
---
# Review Result: Review Result

- Created: 2026-07-17T16:27:44.724Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: PASS on all 5 review gates. checkHolderIdentity extraction preserves stopLockHolder's decision tree byte-for-byte (same order dead -> no-recorded-start -> query-failed -> mismatch -> fallthrough-to-signal, same message strings and reason codes). acquireMutex's unverifiable-identity path (no-recorded-start/query-failed) correctly falls through to the deadline-wait branch (treated as held), the opposite fail-closed direction from stopLockHolder's refusal-to-touch, matching the PR's stated design and the pre-existing crew decision memory (d4860e0c). Pre-fix `{pid}`-only sentinels (no startedAt) hit no-recorded-start and are still treated as held, not stolen -- rolling-upgrade safe. Recycled-PID sentinel (alive PID, mismatched start time) is stolen immediately per the new test, elapsedMs < 2s asserted and passing. All 6 Wave-0 concurrency-guarantee tests (max-concurrency=1, mutex-holds-through-bind, MutexTimeoutError, stale-sentinel-steal) pass unchanged alongside the 2 new #415 tests -- 35/35 total, verified by direct run against a fresh clone of the branch (not the shared dispatch worktree). tsc build clean.
- Evidence Checked:
  - Cloned fix/instance-lock-sentinel-identity fresh into scratch dir (not shared worktree wt-instance-lock-sentinel). bun install clean. bun run build clean (tsc -p .). bun run vitest run tests/service/instance-lock.test.ts -> Test Files 1 passed
  - Tests 35 passed (35)
  - including issue #415 LOW recycled-PID-stolen-immediately (elapsedMs<2000 asserted) and matching-identity-waits tests
  - plus unchanged max-concurrency=1
  - mutex-holds-through-bind
  - MutexTimeoutError
  - and all stopLockHolder identity-check tests (drift+force
  - drift+no-force
  - no-startedAt fail-closed
  - query-failed fail-closed
  - real spawned-process end-to-end). Read full acquireMutex (lines 133-227) and stopLockHolder (lines 492-560) post-refactor to confirm control-flow parity against the diff.
- Files Reviewed:
  - src/service/instance-lock.ts
  - tests/service/instance-lock.test.ts
- Test Adequacy: 35/35 instance-lock.test.ts pass on a fresh clone of the PR branch, including both new #415 recycled-PID tests and all 6 pre-existing Wave-0 concurrency/identity regression tests; no test gaps found for the changed decision paths.
- Judge: reviewer
- Risks: none — logic verified line-by-line against pre-PR behavior for stopLockHolder (byte-identical decision tree) and acquireMutex (correct opposite fail-closed direction); rolling-upgrade pre-fix sentinel shape confirmed still treated as held
- Required Follow-up: none

