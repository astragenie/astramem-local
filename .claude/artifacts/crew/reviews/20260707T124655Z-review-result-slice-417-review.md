---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: rejected
---
# Review Result: Review Result

- Created: 2026-07-07T12:50:38.564Z
- Reviewer: reviewer
- Decision: rejected
- Status: completed
- Summary: Rollback-on-mismatch is only wired for the 'healthy-but-wrong-version' branch; install-service exceptions, start-service exceptions, and health-check-timeout all leave current.json pinned to the just-repointed release with zero restore attempt, reintroducing the outage's failure class (permanent unbootable-daemon crash-loop) this P0 slice exists to close.
- Evidence Checked:
  - Read src/cli/reinstall.ts (full)
  - src/service/{shim
  - release
  - install-flow}.ts (full)
  - tests/service/{shim
  - release}.test.ts (full). Ran 'bun run build' (tsc clean) and 'npx vitest run tests/service/' -> 7 files / 63 tests passed
  - confirming the green claim. No tests/cli/reinstall.test.ts exists — the restore-prior-pointer logic itself is untested. Traced reinstall.ts: priorPointer captured at line ~121-129 (correctly BEFORE stop-daemon/repoint
  - good). writePointer restore only invoked inside the body.version!==pkgversion branch (lines 205-227). The install-service catch (171-176)
  - start-service catch (184-187)
  - and the '!healthy' branch (192-193) all push a failed step and fall through to finish()/exit(1) WITHOUT calling writePointer(priorPointer
  - pointerPath) first — current.json stays pointed at the new release in all three paths.
- Files Reviewed:
  - src/cli/reinstall.ts
  - src/service/install-flow.ts
  - src/service/shim.ts
  - src/service/release.ts
  - tests/service/shim.test.ts
  - tests/service/release.test.ts
- Test Adequacy: shim.test.ts and release.test.ts are thorough (63/63 green, cover AC-1/2/3/4 for writePointer atomicity and the reuse re-verify self-heal) but reinstall.ts — where the actual rollback decision logic lives and where the bug was found — has zero test coverage; the logic is inlined in one large exported function, not unit-testable in isolation.
- Risks: HIGH: any reinstall failure after the pointer write other than a healthy-but-wrong-version response (schtasks registration throwing, service start throwing, or the daemon simply never answering /health within 30s) leaves current.json pinned to the unverified/broken release with the prior daemon already stopped — the OS keepalive (PT5M) then restarts against the same broken pointer indefinitely with no auto-recovery, which is functionally the same outage class (silent, permanent daemon-down) this FEAT was written to close, just moved one layer down. MEDIUM: non-Windows (linux/darwin) reinstall has no shim/pointer indirection at all (install-flow.ts only writes a shim on win32), so priorPointer is always null there and the restore path is structurally unreachable on those platforms — documented in a code comment as 'Windows only' but the emitted message ('no prior pointer to restore (first install...)') is misleading on every non-Windows run, not just first install. LOW: src/service/release.ts:226-257 has a narrow TOCTOU race if two reinstalls target the same version+gitsha concurrently (existsSync check vs renameSync) — surfaces as a raw fs error rather than a friendly message; acceptable for a single-operator admin CLI.
- Required Follow-up: Required before merge: (1) extract the restore-prior-pointer call into a shared helper and invoke it from the install-service catch, the start-service catch, AND the '!healthy' branch — not just the version-mismatch branch — so ANY post-repoint failure restores the last known-good pointer, matching the slice's own Reviewer-B mandate ('a failed materialize/assert leaves the PRIOR working pointer intact, no worse than before'); (2) add tests/cli/reinstall.test.ts (or extract the restore logic into shim.ts/a pure function so it's unit-testable) covering: version-mismatch restores, install-service-throw restores, health-timeout restores, and the no-prior-pointer (first install) case. Non-blocking follow-up: track the non-Windows no-rollback gap as a ticket (SLICE-418 or new) since it's an explicitly scoped-out platform gap, not a regression in this slice.

