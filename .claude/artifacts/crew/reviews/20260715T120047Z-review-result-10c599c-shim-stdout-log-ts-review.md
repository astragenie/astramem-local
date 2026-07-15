---
findings: "🔴:0,🟡:2,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-15T12:02:29.659Z
- Reviewer: typescript-reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Sound fix for the stdout-visibility gap; one real fd-leak edge case in the dual-openSync catch block, plus an unbounded-growth concern for daemon-stdout.log during long-lived daemon runs — both narrow, non-blocking.
- Evidence Checked:
  - MEDIUM src/service/shim.ts:288-301 (LAUNCHER_SOURCE template) — if openSync(stdoutLogPath) succeeds but the following openSync(stderrScratchPath) throws
  - the catch block unconditionally sets stdoutFd = null (line 299) without closing the already-opened fd first. That real fd is never passed to spawnSync (stdoutStdio becomes 'ignore' since stdoutFd is null) and never reaches the close block at lines 340-345 either (also gated on stdoutFd !== null). It leaks for the duration of the shim process — which
  - per this file's own comment at line 305-309
  - IS the daemon's lifetime (spawnSync blocks days/weeks under the keepalive architecture)
  - so the leaked handle sits open for a long time
  - not just briefly. Narrow trigger (logs dir writable for the first open
  - then fails before the second — e.g. AV lock
  - disk-full mid-write
  - ACL race) but the mitigation is one line: close stdoutFd inside the catch before nulling it. MEDIUM not HIGH: rare trigger
  - self-heals on next launch cycle
  - no crash/data-loss. MEDIUM src/service/shim.ts (stdoutLogPath open
  - 'w' truncate-on-launch-only) — confirmed via grep that pipeline job handlers (cleanup.ts
  - reembed.ts
  - distill.ts
  - transcribe.ts — 42 files total using console.log) write to stdout throughout the daemon's life
  - not just at boot
  - so daemon-stdout.log is NOT boot-only output as the commit message's example lines suggest. The file is opened once per launch and never truncated/rotated again until the NEXT launch (upgrade/restart) — under the stated days/weeks keepalive runtime a single run's stdout has no size cap
  - unlike crash.log which stays bounded via CRASH_LOG_MAX_BYTES + readTail(). Not a correctness bug
  - but an unbounded-disk-growth gap worth a follow-up (size cap + truncate-in-place
  - or point at the same rotation the pino file logger already gets). No CRITICAL/HIGH findings: no 'inherit' reaches spawnSync on any path (confirmed — stdin hardcoded 'ignore'
  - stdout/stderr always fd-or-'ignore'); FEAT-440 stderr crash-capture path is untouched by this diff; the new stdout-log test (writes 'serving on...' via a real child process
  - spawnSync's the launcher
  - reads back daemon-stdout.log) and the updated stdio-array regression-guard string assertion are both valid and test real behavior
  - though neither covers the partial-open-failure fd-leak path above. Note: the reviewed code (LAUNCHER_SOURCE
  - shim.ts:135 diff region) is a plain-JS template-literal string written out to launch.cjs at install time
  - not compiler-checked TS — most strict-mode/type-safety checklist items (any
  - casts
  - branded types
  - Zod boundaries) are inapplicable to this diff; shim.ts's own TS-checked generator code (writeShim
  - etc.) was not touched.
- Files Reviewed:
  - src/service/shim.ts
  - tests/service/shim.test.ts
- Test Adequacy: Author-reported 26/26 shim.test.ts green, tsc clean; not independently re-run by this review (read-only stack review).
- Risks: -
- Required Follow-up: -

