---
findings: "🔴:0,🟡:1,❓:2"
status: completed
decision: approved_with_notes
author_id: crew:fullstack-dev
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-19T19:21:24.133Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Windowless-daemon VBS hidden-launch mechanism is implemented correctly (blocking bWaitOnReturn=True by construction across all three wrappers, correct VBScript quote-doubling escaping verified by hand-tracing and by round-trip tests, stable .cmd pointer preserved for the daemon, all XML settings/tiers intact, 224/224 tests green, tsc clean) -- approved with notes: a real but conditional (WSH-policy-dependent) silent-outage risk with no fallback/canary, and a likely-incorrect "Tier C already windowless" claim, both need tracked follow-up before this is considered fully closed.
- Evidence Checked:
  - bunx vitest run tests/service: 14 files / 224 tests passed. bunx tsc --noEmit -p .: clean
  - zero errors. Hand-traced vbsQuote/buildHiddenVbs quote-doubling for a Program-Files-style spaced path and confirmed it round-trips to the exact intended VBScript Run() string literal (also confirmed by tests/service/shim.test.ts's own round-trip test). Confirmed bWaitOnReturn=True is hardcoded once inside buildHiddenVbs so all 3 wrappers (daemon via writeShim
  - backup + watchdog via installHiddenWrapper) share it by construction
  - not by per-call parameter. Confirmed daemon VBS commandLine references paths.cmdPath (the STABLE shim
  - shim.ts:518) never a release path; confirmed backup/watchdog intentionally bake build.rawExecPath and are rewritten on every install call (pre-existing design
  - unchanged by this diff). Confirmed XML Tier 0 and CLI Tier A/B for the daemon task share the same hiddenCommand/hiddenArgs variables (schtasks.ts install()
  - computed once) so no tier can drift to a visible-window fallback. Confirmed task-xml.ts ExecutionTimeLimit=PT0S
  - MultipleInstancesPolicy=IgnoreNew
  - LogonType=InteractiveToken
  - dual LogonTrigger+TimeTrigger were untouched by this diff. Cross-referenced docs/adr/ADR-020-windows-supervisor-process.md
  - this repo's own in-flight design doc for the identical wscript.exe+VBS mechanism
  - which flags it as its single lowest-confidence risk and makes a live-smoke-test + PowerShell-fallback + mechanism-logging a BLOCKING Phase-2 gate -- none of which this diff implements.
- Files Reviewed:
  - src/service/shim.ts
  - src/service/schtasks.ts
  - tests/service/shim.test.ts
  - tests/service/schtasks.test.ts (task-xml.ts and install-flow.ts read but unmodified by this diff)
- Test Adequacy: 224/224 existing + newly-added unit tests green (vitest tests/service), covering VBS quote-escaping round-trip, blocking-flag presence, per-tier (XML/CLI-A) wscript.exe routing for the daemon and backup tasks, and vbs-write content for all three wrappers; tsc --noEmit clean. No live Windows smoke test exists or was expected at this stage -- the user has explicitly reserved the live reinstall + visual window-gone verification for themselves immediately after this review.
- Author: crew:fullstack-dev
- Judge: crew:reviewer
- Risks: HIGH (residual, not blocking): wscript.exe could be disabled/blocked by WSH group policy, Defender ASR, or AppLocker/WDAC on hardened machines -- if so, the PT5M keepalive tick silently fails before ever reaching launch.cjs, producing zero exit-history.jsonl entries and therefore no doctor crash-loop signal: a dead daemon on such a box would simply never restart, with no diagnosable symptom. MEDIUM: Tier C (Startup-folder fallback) was deliberately left un-wrapped on the stated belief it 'already runs windowless via start /B' -- likely false, since Windows shows the outer cmd.exe console for a Startup-folder .cmd file regardless of internal /B usage.
- Required Follow-up: 1) Track a fast-follow to add an install-time smoke check (or doctor probe) that exercises the hidden-launch VBS against a trivial marker command and WARNs loudly if it fails, so a wscript-blocked machine gets a diagnosable signal instead of silence. 2) When the user runs their planned live reinstall + visual verification, also explicitly kill the daemon process and confirm the PT5M tick actually restarts it (not just that install succeeds and the window is gone). 3) Either wrap Tier C's Startup-folder script in the same buildHiddenVbs()/wscript.exe pattern for consistency, or correct the commit-message claim that it is already windowless. 4) Add a wscript.exe/vbs assertion to the installWatchdogTimer CLI-fallback test to match the daemon/backup fallback tests' coverage.

