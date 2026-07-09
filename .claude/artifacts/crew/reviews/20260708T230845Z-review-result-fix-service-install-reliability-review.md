---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-08T23:12:23.395Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Both bugs fixed correctly with no regressions: verify-health false-positive rollback fixed via 90s configurable budget, stop-daemon gap fixed via PID-based stopLockHolder; success path never stops a healthy verified daemon; one pre-existing MEDIUM (EPERM/ESRCH conflation in liveness check) now exercised by a new code path (service stop).
- Evidence Checked:
  - Read full diff (5 files
  - 245+/57-). Confirmed restoreOnce()/stopLockHolder is only invoked on failure/rollback branches in reinstall.ts
  - never on the verify-version success path — normal successful reinstall cannot kill the newly-verified daemon. All 6 restoreOnce() call sites properly awaited (async conversion complete
  - no floating promises). stopLockHolder is dataDir-scoped so it cannot cross-affect an unrelated daemon on a different data dir. service.ts stop is idempotent: no-lock and stale-lock (dead PID) both return ok:true with no error; adapter.stop() failure (e.g. task never installed) is now non-fatal
  - PID-stop is the real success signal
  - matching the idempotency requirement in the review brief. bun run build (tsc -p .) clean. bunx vitest run tests/service tests/cli/reinstall.test.ts: 10 files
  - 114 tests passed. Full bunx vitest run: 164 files
  - 1895 passed / 6 skipped
  - 0 failed — no regressions anywhere in the suite. Also found a pre-existing independent typescript-reviewer artifact in the worktree (20260708T230850Z) that reached the same approved_with_notes verdict with the identical MEDIUM finding
  - corroborating this review.
- Files Reviewed:
  - src/service/instance-lock.ts
  - src/cli/reinstall.ts
  - src/cli/service.ts
  - tests/service/instance-lock.test.ts
  - tests/cli/reinstall.test.ts
- Test Adequacy: Builder's new stopLockHolder tests cover: no-lock idempotency, stale/dead-PID idempotency (no signal sent), successful stop (signal sent + health probe goes unhealthy), timeout failure (health probe stays healthy past waitMs), and signal-throw surfaced as failure — all via injected signal/healthProbe fakes, no real process killed. healthTimeoutMs() tests cover default/valid-override/non-numeric/zero/negative. Gap: no test exercises the EPERM (permission-denied-but-alive) branch of the underlying pid-liveness check, matching the MEDIUM finding below. Full suite green (1895/1895), confirming no regression elsewhere.
- Risks: MEDIUM (src/service/instance-lock.ts:131-136, stopLockHolder; mirrored at :46-53, pidAlive): process.kill(pid,0) treats ANY thrown error as 'process is dead', conflating ESRCH (no such process — correctly stale) with EPERM (process exists but caller lacks permission to signal it, e.g. different-user daemon). On EPERM, stopLockHolder reports 'stale lock (pid X already dead)' and returns ok:true WITHOUT sending SIGTERM — a live daemon is silently left running while the caller believes it stopped. This pattern already existed pre-diff in reinstall.ts's old stopRunningDaemon (not a new regression there), but this diff newly wires it into service.ts's stop command too, so the blast radius of the gap has grown from 'reinstall repoint failure path' to 'every plain service stop call'. Likelihood is low given this repo's same-user local-daemon deployment model. Separately, LOW: stopLockHolder verifies PID liveness only, not process identity (no cmdline/exe-path check) — a crashed daemon whose PID gets reused by an unrelated process before the next stop/reinstall would have that unrelated process signaled. Same pre-existing PID-trust model as acquireInstanceLock's steal logic, unchanged by this diff, not a new hazard class. Neither finding is exercised in normal operation and neither blocks this fix from the two bugs it targets.
- Required Follow-up: Optional low-risk follow-up: in the pid-liveness check (both pidAlive() and stopLockHolder's inline check), inspect (err as NodeJS.ErrnoException).code and only treat 'ESRCH' as dead; treat EPERM as alive-but-unsignalable and surface that distinctly in the returned detail string. Add a test for the EPERM branch. Not required before merge.

