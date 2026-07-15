---
findings: "🔴:0,🟡:1,❓:3"
status: completed
decision: approved_with_notes
author_id: crew:fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-15T05:24:59.194Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: FEAT-507 (branch feat/507-reembed-oversize-poisons, a90ee70) reviewed: correct, well-tested fix
for the reembed oversize-poison misclassification bug. No CRITICAL/HIGH findings. One MEDIUM
idempotency gap and a few documented/acceptable LOW items.
- Evidence Checked:
  - Diff origin/main...feat/507-reembed-oversize-poisons read in full (9 files
  - 634 insertions). Ran 44 directly-affected tests (tests/pipeline/oversize.test.ts
  - tests/pipeline/oversize-scanner.test.ts
  - tests/pipeline/reembed.test.ts
  - tests/storage/memories.test.ts) in the branch's own worktree (agent-a46ed11f6b23fe2c4
  - HEAD a90ee70) via npx vitest run — all 44 green. tsc --noEmit clean. Cross-referenced src/pipeline/worker.ts (state machine
  - backoff)
  - src/pipeline/job-repo.ts (fail/requeueForRetry/markPoison)
  - src/providers/embed/ollama.ts (confirms every >=500 is thrown as TransientError
  - matching oversize.ts's doc claim)
  - and src/pipeline/errors.ts (DeterministicError/TransientError signatures) to verify the reclassification wiring is correct and ADR-015 loud-failure invariant holds (no silent catch; every failure path logs and surfaces via job.last_error / recordHandlerRun). serve.ts timer block diffed line-by-line against the existing consolidateTimer/cleanupTimer blocks it was modeled on — identical guard/unref/shutdown-clear pattern
  - no leak.
- Files Reviewed:
  - src/pipeline/oversize.ts
  - src/pipeline/handlers/reembed.ts
  - src/pipeline/oversize-scanner.ts
  - src/storage/memories.ts
  - src/cli/serve.ts
  - tests/pipeline/oversize.test.ts
  - tests/pipeline/oversize-scanner.test.ts
  - tests/pipeline/reembed.test.ts
  - tests/storage/memories.test.ts
- Test Adequacy: 44 tests directly re-run green, covering truncation boundary math, both-direction reclassification (context-length-exceeded -> Deterministic, genuinely-transient -> unchanged), scanner idempotency across pending/completed/no-candidate/cap-at-limit states, and listOversizeNeedingVecIndex flag+size filtering; TDD-adequate for this net-new behavior. Gap: no test covers the 'failed'-state race identified in findings (MEDIUM).
- Author: crew:fullstack-dev
- Judge: crew:reviewer
- Risks: MEDIUM idempotency gap (failed-state race, see findings) can duplicate a reembed job in a narrow ≤60s window once per hour-tick; benign (no data corruption, wasted embed call only) but untested. Threshold hardcode and error-string-match are both documented, deliberate, safe-direction follow-ups per FEAT-507's own scope notes.
- Required Follow-up: Fast-follow: change oversize-scanner.ts's hasPendingOrRunningReembedJob predicate to also treat 'failed' as in-flight (or NOT IN ('completed','poison')) and add a regression test seeding a 'failed' reembed job. AC-4 doctor oversize sub-label deferral is an acceptable scope boundary, not a gap — the scanner's own console.log counters already give operational visibility without it.

