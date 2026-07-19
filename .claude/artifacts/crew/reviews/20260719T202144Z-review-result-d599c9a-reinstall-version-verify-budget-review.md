---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
author_id: herolegion
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-19T20:29:16.518Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Reviewed commit d599c9a on feat/windowless-daemon (single file: src/cli/reinstall.ts, +27/-7). Correctness lens.

Verified:
1. versionVerifyBudgetMs() (reinstall.ts:56-63) is a faithful mirror of the existing, tested healthTimeoutMs() (reinstall.ts:96-103): same env-read → Number() → Number.isFinite(n) && n > 0 guard → fallback pattern, default 90_000, distinct env var ASTRA_MEMORY_REINSTALL_VERSION_TIMEOUT_MS. Correct.
2. All 4 call sites updated consistently: waitForVersion() at reinstall.ts:345 and :555, error-message interpolations at :375 and :577. grep for the old VERSION_VERIFY_BUDGET_MS constant name returns zero hits anywhere in src/ or tests/ — fully removed, no dangling reference, no corruption of the new DEFAULT_VERSION_VERIFY_BUDGET_MS constant.
3. Tradeoff claim verified against src/cli/wait-health.ts:44-71 waitForVersion(): the polling loop only returns {ok:true} on an exact version match (line 63) and otherwise loops silently until the deadline (line 65-68) — it has no early-exit branch for "responded but wrong version," so a genuine mismatch does ride out the full budget, exactly as the new code comment (reinstall.ts:50-53) describes. This poll-vs-fast-fail behavior lives entirely in wait-health.ts, which this commit does NOT touch — the commit only changes how long callers wait, not the polling semantics. Grepped the repo for other dependents on the old 30s constant or on waitForVersion — none found outside reinstall.ts and its own test file. No other guard depends on the removed fast-fail window.
4. `bunx tsc --noEmit -p .` — clean, no errors.
   `bunx vitest run tests/cli/reinstall.test.ts tests/cli/wait-health.test.ts` — 2 files, 24 tests, all passed.

Finding (test-adequacy gap, not a correctness bug in the shipped code):
[HIGH] tests/cli/reinstall.test.ts — the new exported `versionVerifyBudgetMs()` (reinstall.ts:56) ships with ZERO test coverage. Its sibling `healthTimeoutMs()`, which this commit explicitly mirrors, has a dedicated 5-case describe block at tests/cli/reinstall.test.ts:162-192 (default-90s, valid-override, non-numeric-fallback, zero/negative-fallback) — and the test file's only import from reinstall.ts (line 35) does not even name `versionVerifyBudgetMs`. This is a straight copy of already-tested logic, so the immediate defect risk is low, but a future edit (env var name typo, comparison flip, unit confusion) to this function would ship with no regression test to catch it, unlike its twin.
Risk: silent regression in the env-override parsing path for ASTRA_MEMORY_REINSTALL_VERSION_TIMEOUT_MS on a future edit — nothing in CI would fail.
Fix (isolated, low-risk, ~10 min): add a `describe('versionVerifyBudgetMs ...)` block mirroring reinstall.test.ts:162-192, importing versionVerifyBudgetMs and asserting against ASTRA_MEMORY_REINSTALL_VERSION_TIMEOUT_MS with the same 4 cases (default 90_000, override 120_000, non-numeric fallback, zero/negative fallback).

Residual risk (informational, not blocking): worst-case total time-to-rollback for a genuine corrupt-release version mismatch is now ~90s (health) + ~90s (version) = ~180s, up from ~90s+30s=~120s before this change. This is the explicitly acknowledged and reasonable tradeoff described in the commit message (false-failing every busy cold start was strictly worse, and mismatch is rare) — flagging only so it's visible to whoever owns rollback-latency SLOs, not as something to fix here.

Decision: approved_with_notes. Code change itself is correct, mirrors an established tested pattern, all call sites updated, no regressions, tsc+targeted tests green. The one HIGH finding is a test-coverage gap (not a functional defect) with an isolated, low-risk, well-specified fix — does not block merge per policy, but should be closed out promptly (same PR or immediate fast-follow).
- Evidence Checked:
  - reinstall.ts:56-63 mirrors healthTimeoutMs (reinstall.ts:96-103) exactly; grep confirms VERSION_VERIFY_BUDGET_MS fully removed with no dangling refs (call sites at :345
  - :375
  - :555
  - :577 all updated); wait-health.ts:44-71 waitForVersion confirmed to ride out full budget on version mismatch (unchanged by this diff
  - so tradeoff claim in the new comment is accurate); bunx tsc --noEmit -p . clean; bunx vitest run tests/cli/reinstall.test.ts tests/cli/wait-health.test.ts = 2 files/24 tests passed
- Files Reviewed:
  - src/cli/reinstall.ts
- Test Adequacy: Existing reinstall.test.ts (24 tests) and wait-health.test.ts pass unchanged; however the new exported versionVerifyBudgetMs() has zero dedicated tests — its sibling healthTimeoutMs() has a 5-case describe block (default/override/non-numeric/zero/negative) that was not mirrored for the new function.
- Author: herolegion
- Judge: crew:reviewer
- Risks: Worst-case rollback latency for a genuine version mismatch rises from ~120s to ~180s (90s health + 90s version) — explicitly acknowledged tradeoff in the commit, not a defect. Test-coverage gap on versionVerifyBudgetMs() (see findings) is the only open item.
- Required Follow-up: Add a describe('versionVerifyBudgetMs...) block to tests/cli/reinstall.test.ts mirroring the existing healthTimeoutMs block (lines 162-192), covering default-90s, valid-override, non-numeric-fallback, and zero/negative-fallback against ASTRA_MEMORY_REINSTALL_VERSION_TIMEOUT_MS. Isolated, low-risk, non-blocking for merge.

