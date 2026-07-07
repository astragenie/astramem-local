---
findings: "🔴:0,🟡:0,❓:1"
status: completed
decision: approved
---
# Review Result: Review Result

- Created: 2026-07-07T13:02:31.669Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: All 5 post-repoint failure branches (install-service catch:219, start-service catch:234, !healthy:244, version-mismatch:267, version-fetch catch:278) now call the memoized restoreOnce()/restorePriorPointer helper correctly; build clean, 70/70 tests green; one LOW defense-in-depth note on the soft-fallback branch, non-blocking.
- Evidence Checked:
  - Traced src/cli/reinstall.ts line-by-line: priorPointer captured at 157-165 (before stop-daemon at 178 and before repoint inside installServiceFlow at 190); restoreOnce closure (170-176) memoizes via pointerRestoreDetail so chained failures (e.g. start-throw then health-timeout) write current.json at most once. All 5 branches call restoreOnce() and every branch's steps array retains an ok:false entry that reaches finish() (either via early return+finish at 223-224
  - or the single finish() at 305)
  - so process.exit(1) fires in all cases. restorePriorPointer (59-76) handles non-win32 (accurate 'Windows-only' message
  - no false restore claim)
  - null prior (honest 'first install' no-op
  - no side effect)
  - and writePointer throw (caught
  - surfaced as 'restore FAILED ... fix manually'
  - not swallowed) -- matches tests/cli/reinstall.test.ts exactly. bun run build: tsc clean. npx vitest run tests/service/ tests/cli/reinstall.test.ts: 8 files / 70 tests passed.
- Files Reviewed:
  - src/cli/reinstall.ts
  - tests/cli/reinstall.test.ts
  - src/service/install-flow.ts (read for context)
  - src/service/shim.ts (read for context)
  - src/service/schtasks.ts (read for context)
- Test Adequacy: 7 new tests in tests/cli/reinstall.test.ts exercise restorePriorPointer directly (version-mismatch/install-throw/start-throw/health-timeout/no-prior-pointer/non-Windows/writePointer-failure); the first four are intentionally near-duplicate calls to the same pure function since the fix's whole point is that every reinstallCommand branch now funnels through one restore decision -- appropriate given reinstallCommand itself drives real schtasks/fetch/process.exit and is not practically unit-testable (documented in the test file's own header). Gap: no test exercises reinstallCommand's control flow itself (i.e., that each catch block actually calls restoreOnce) -- verified instead by manual code trace in this review, which is an acceptable substitute given the CLI-untestability constraint the prior review itself acknowledged.
- Risks: LOW (non-blocking): the install-service SOFT-fallback branch (result.kind !== 'task', lines 208-217) does not call restoreOnce() directly. Traced the control flow: since startFn stays null in that branch, step 5 (start) is skipped, so in the realistic failure mode (schtasks totally unavailable -> Startup-shortcut fallback, no daemon actively started) waitForHealth times out at step 6 and the !healthy branch (line 244) calls restoreOnce() for it -- so today it does restore, just indirectly. The narrow edge case this doesn't cover: current.json is repointed by writeShim() BEFORE adapter.install() runs (install-flow.ts:78 precedes :86), so if a PRE-EXISTING schtasks task from an earlier successful reinstall survives a failed /create /f re-registration attempt and its PT5M keepalive happens to fire inside the 30s health-wait window, the daemon could start from the just-repointed (unproven) release and report healthy+correct-version before restoreOnce ever fires -- current.json would then stay pinned to a release that was never actually proven by ITS OWN install/start path, purely because a stale prior task got lucky on timing. Low probability, Windows-scheduler-timing-dependent, not a regression versus the pre-fix state.
- Required Follow-up: Optional hardening, not required for merge: add an explicit restoreOnce() call inside the result.kind !== 'task' branch (~213-216) so the soft-fallback path restores deterministically rather than relying on the downstream health-check timeout to catch it. No code or test changes are required to ship this fix as-is.

