---
findings: "🔴:0,🟡:0,❓:1"
status: completed
decision: approved
---
# Review Result: Review Result

- Created: 2026-07-08T23:27:24.995Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: HIGH (daemon-kill vector) is fully closed: stderr now goes through an OS fd to a scratch file with no in-process buffer, so neither the ENOBUFS-kill nor an unbounded memory leak can occur; build and all 170 tests (19 files) pass clean.
- Evidence Checked:
  - git show ac6d141 (src/service/shim.ts): LAUNCHER_SOURCE opens stderrScratchPath via openSync(...
  - 'w')
  - passes the numeric fd (not 'pipe') as stdio[2] to spawnSync
  - closes it after spawnSync returns
  - then readTail() does fstatSync+positioned readSync capped at CRASH_TAIL_READ_BYTES=63KB (never loads full file); mkdirSync+openSync wrapped in try/catch falling back to stdio 'inherit' on failure (AC-4 preserved); spawnSync (blocking) unchanged — no switch to async spawn. New regression test 'a daemon emitting >1MB cumulative stderr is NOT killed...' (tests/service/shim.test.ts:234-279) writes 2MB stderr and asserts res.status===3 (real exit code
  - not an ENOBUFS null-status kill) and crash.log stays <70KB. bun run build: clean
  - zero errors. bunx vitest run tests/service tests/doctor tests/scripts: 19 files
  - 170 tests
  - all passed.
- Files Reviewed:
  - src/service/shim.ts
  - tests/service/shim.test.ts
  - scripts/git-hooks/post-merge-rebuild.mjs
- Test Adequacy: New regression test directly proves the fix: >1MB cumulative stderr no longer triggers an ENOBUFS kill (real exit code 3 observed) and crash.log stays bounded (<70KB) while still containing the tail marker; full service/doctor/scripts suites (170 tests) green after the change.
- Risks: None blocking. The 'two unused-import lints' flagged in the dispatch (readdirSync, crashLogPath destructure at tests/service/shim.test.ts:247) are both actually used (readdirSync at line 68, crashLogPath at line 271) — that report appears stale/incorrect, not a real issue. The new SPAWN_TIMEOUT_MS on post-merge-rebuild.mjs's spawnSync has no dedicated regression test, but it's a minor bounded addition and the existing post-merge-rebuild test suite still passes.
- Required Follow-up: Optional: add a timeout-path test for scripts/git-hooks/post-merge-rebuild.mjs (SPAWN_TIMEOUT_MS) if that hook's reliability under a hung install ever becomes a concern; not blocking for this fix.

