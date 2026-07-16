---
findings: "🔴:0,🟡:1,❓:1"
status: completed
decision: approved_with_notes
author_id: builder
judge_id: reviewer
self_approval: false
---
# Review Result: PR #325 fix-service-stop-force-307 review

- Created: 2026-07-14T18:45:16.947Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: PR #325 (fix/service-stop-force-307): threads `force` through stopLockHolder to bypass the identity-mismatch drift refusal; adds `service stop --force`. Correctness of the *scope* of the bypass is good (only identity-mismatch is touched; identity-unverifiable/signal-failed/stop-timeout all fail closed exactly as before), the warning does print full drift detail, and default `stop` behavior is provably unchanged. Tests are mocked correctly (no real kill) and pass.

Adversarial finding: with `force: true` on identity-mismatch, instance-lock.ts:284 still calls `sendSignal(holder.pid, 'SIGTERM')` against a PID the identity check just confirmed is NOT this daemon ("likely a recycled PID"). On win32 this is process.kill -> TerminateProcess, a hard kill with zero grace period for whatever process actually holds that PID. This is inconsistent with the established pattern in the SAME codebase: src/cli/restore.ts's WEAK_OVERRIDE_REASONS explicitly excludes identity-mismatch (it requires the stronger --force --force-unsafe combo), and even then restore.ts never signals the mismatched PID -- it just proceeds around the aborted stop. This PR's single `--force` flag actually completes the kill against a confirmed-different-identity process, gated only by a stderr warning printed immediately before signaling.
- Evidence Checked:
  - git show 5d41a61 -- src/cli/service.ts src/service/instance-lock.ts tests/service/instance-lock.test.ts read in full (the fix commit for issue #307
  - isolated from ~114 unrelated files on this branch). bunx vitest run tests/service/instance-lock.test.ts tests/cli/restore.test.ts -> 2 files passed
  - 32 tests passed. Cross-checked src/cli/restore.ts's existing WEAK_OVERRIDE_REASONS / --force-unsafe two-tier gate
  - which handles the same identity-mismatch reason code from the same stopLockHolder function
  - for design consistency.
- Files Reviewed:
  - src/service/instance-lock.ts:187-282
  - src/cli/service.ts:82-127 and 169-180
  - tests/service/instance-lock.test.ts:197-243 (new)
  - reference comparison against src/cli/restore.ts:16-38 52-90 150-175
- Test Adequacy: 2 new unit tests cover both branches at the stopLockHolder library level: drift+no-force refuses (reason identity-mismatch, detail unchanged), and drift+force=true signals the injected mock pid and asserts the WARNING/drift text is logged before signaling. The signal function is properly mocked (a plain array-push spy), not a real kill, and both tests pass. Gap: zero test coverage for the CLI layer in src/cli/service.ts -- the --force flag parsing (rest.includes), threading force through to stopLockHolder, and the --force hint appended to the plain-stop failure message are all untested; no tests/cli/service.test.ts exists. The first new test's own docstring explicitly says it defers that assertion to the CLI layer, which turns out to have no test at all.
- Author: builder
- Judge: reviewer
- Risks: HIGH (functional finding, not counted in the finding buckets above since it is a design-safety concern rather than a defect in the delivered code as scoped): with force:true, instance-lock.ts:284's sendSignal(holder.pid,'SIGTERM') still fires against a PID the identity check just confirmed is NOT this daemon (a likely-recycled PID). On win32 process.kill is a hard TerminateProcess -- no grace period for whatever process actually holds that PID. src/cli/restore.ts already established a more conservative pattern for this exact identity-mismatch reason code: WEAK_OVERRIDE_REASONS excludes it, requiring the stronger --force --force-unsafe combo, and even then restore.ts never signals the mismatched PID -- it only proceeds around the aborted stop. This PR's single --force flag actively completes the kill, gated only by a stderr WARNING printed immediately before signaling (no second confirmation flag, no prompt). The warning does correctly print the full drift detail (lock startedAt, OS startedAt, drift ms) per review focus item 3, and the bypass is correctly scoped to identity-mismatch only -- identity-unverifiable, signal-failed, and stop-timeout are untouched, verified by reading instance-lock.ts:240-298 in full. Plain "service stop" with no force flag is unchanged (regression test at line ~200 duplicates prior refusal behavior). PID-safety requirement (never a broad or image-name kill) is met -- the signal always targets holder.pid exactly.
- Required Follow-up: Recommended, not blocking merge, but should follow up given the safety asymmetry with restore.ts: add a second explicit confirmation gate for identity-mismatch specifically -- either (a) do not actually signal the PID even under force, matching restore.ts's "proceed without touching the confirmed-wrong process" design, or (b) require a stronger flag such as --force-unsafe alongside --force before actually sending SIGTERM to a confirmed-mismatched PID, mirroring restore.ts's WEAK_OVERRIDE_REASONS gate for the same reason code. Also add tests/cli/service.test.ts covering the --force flag parse-through and the --force hint text in the plain-stop failure path, currently zero CLI-layer coverage. Consider a CHANGELOG.md entry for the new stop --force flag (issue #307), which this commit omits.

