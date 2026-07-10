---
findings: "🔴:0,🟡:1,❓:2"
status: completed
decision: approved_with_notes
author_id: crew:builder
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-10T17:38:07.756Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: FEAT-462b fix round (d47555a..0177406) closes round-1 Finding 1: killManifestDaemons now gates every signal behind checkPortOwner (netstat -ano on win32, lsof on POSIX), verified fail-closed on all exception paths, wired load-bearing into the new kill-run.mts CLI with no bypass flag. Guard logic itself is byte-identical between the WIP commit and the final commit (confirmed via diff). Gates: tsc clean, vitest scripts/eval/ 145/145 passed, no flake hit.
- Evidence Checked:
  - daemon-manifest.ts checkPortOwner(port): win32 path shells `netstat -ano -p TCP`
  - filters lines starting "TCP"/"TCP6" containing LISTENING (case-insensitive)
  - extracts port via trailing `:(\d+)$` regex (handles IPv4 and bracketed IPv6 alike)
  - pid via last whitespace column. POSIX path shells `lsof -i :port -t -sTCP:LISTEN`; exit status 1 with no output is the documented "nothing listening" case (distinguished from a genuine tool failure
  - which only maps to status!==1 or a thrown ENOENT). BOTH branches wrap execFileSync in try/catch and return {ok:false
  - reason} on ANY exception; killManifestDaemons treats ok:false as skipped-identity-mismatch. No fail-open path found by inspection.

`git diff 9ebefd1..0177406 -- scripts/eval/shared/daemon-manifest.ts` is EMPTY -- the fix round only completed plumbing (fixture
  - tests
  - CLI
  - docs); the guard logic reviewed here is identical to the WIP commit.

fake-detached-worker.mjs fixture diff confirms it now binds a real node:net TCP listener via server.listen() before starting its heartbeat when `--port` is passed (heartbeat gated on the listen callback
  - not merely on the request
  - closing a stated async-bind race). Ran the 3 new identity-outcome tests + kill-run.test.ts + detach.test.ts verbosely: 21/21 passed with realistic non-mocked timings (415ms/123ms/579ms for the 3 identity tests
  - 393ms for the CLI kill test) consistent with genuine process spawn + port bind + shell-out
  - not mocks. Test (c) explicitly asserts BOTH the real port owner AND the manifest's stale/reused pid have null exitCode/signalCode after the kill attempt -- proves neither was signaled
  - not just "no exception thrown".

kill-run.mts is the ONLY non-test caller of killManifestDaemons in the whole scripts/ tree (grepped); it never passes a bypass/force flag (none exists on the API). It defaults to SIGTERM
  - exits non-zero whenever anything was skipped as identity-ambiguous
  - and only patches run-status.json to 'failed' on a genuine kill -- kill-run.test.ts's last case explicitly asserts run-status.json stays untouched on an identity-ambiguous no-op run. A missing/duplicate --signal value falls back to SIGTERM via JS default-parameter semantics rather than crashing.

Gap: the POSIX/lsof branch (checkPortOwner's non-win32 path and parsePosixLsof) and parseWindowsNetstat have ZERO direct unit-test coverage with canned/edge-case string fixtures (header rows
  - TCP6/bracketed-IPv6 addresses
  - multiple matching rows
  - malformed output). All 3 new identity-outcome tests exercise the real win32 netstat call on this dev box only
  - covering the happy-path column layout produced here. CLAUDE.md notes eval may run on Linux shards
  - and the review brief called this out explicitly. The structural fail-closed guarantee (any exception -> skip) is platform-independent
  - so a parser bug's blast radius is bounded to "more conservative than necessary" (false skip) in most cases -- except a mis-parse that returns a WRONG-but-still-matching pid
  - which is not ruled out by inspection alone for the untested paths.

Gates run and self-verified (not delegated):
- `bunx tsc --noEmit` -- clean
  - zero errors.
- `bunx vitest run scripts/eval/` -- 18 test files
  - 145 tests
  - all passed
  - 0 failed. No known flake (post-merge-rebuild.test.ts / release.test.ts) encountered since scope was restricted to scripts/eval/ per instructions.
- Files Reviewed:
  - scripts/eval/shared/daemon-manifest.ts
  - scripts/eval/shared/daemon-manifest.test.ts
  - scripts/eval/shared/kill-run.mts
  - scripts/eval/shared/kill-run.test.ts
  - scripts/eval/shared/detach.test.ts
  - scripts/eval/shared/__fixtures__/fake-detached-worker.mjs
  - scripts/eval/longmemeval/README.md
  - scripts/eval/locomo/README.md
- Test Adequacy: 3 new identity-outcome tests + kill-run.test.ts (4 cases) genuinely spawn real node processes and bind real TCP ports via the fake-detached-worker fixture; verified 21/21 pass with realistic non-mocked timings; POSIX/lsof parsing path and pure parser functions have zero direct unit coverage (noted in risks)
- Author: crew:builder
- Judge: crew:reviewer
- Risks: 1) MEDIUM -- no unit-test coverage for the POSIX/lsof identity-check path (checkPortOwner non-win32 branch, parsePosixLsof) or for parseWindowsNetstat as a pure function against canned/edge-case netstat output (header rows, TCP6/bracketed-IPv6, multiple matches, malformed lines). scripts/eval/shared/daemon-manifest.ts -- both parser functions and the non-win32 checkPortOwner branch. Risk: if eval shards run on Linux, a latent lsof-output parsing bug would only surface there, and would be unverified by this test suite. Fix: add pure-function unit tests feeding parseWindowsNetstat/parsePosixLsof canned strings (no real process/exec needed) covering header rows, TCP6, multi-match, and malformed input.
2) LOW -- the residual TOCTOU window (process dies AND its pid is reused by a wholly different process in the instant between checkPortOwner's exec and the process.kill call) is not explicitly documented as an accepted risk anywhere in code comments or the README, only the "pid vanished, ESRCH" sub-case is called out. scripts/eval/shared/daemon-manifest.ts:211. Not a logic hole -- the window shrank from unbounded manifest-staleness to a single shell-out+kill round trip -- but worth one comment line for future readers.
3) LOW -- parseWindowsNetstat's LISTENING match (`/LISTENING/i`) assumes English-locale netstat output; a non-English-locale Windows box would fail closed (safe, just non-functional) rather than crash or fail open. Not exercised or flagged anywhere. Low likelihood given this is a controlled dev box, but worth a one-line README/code note if the guard is ever run on an unknown machine.
- Required Follow-up: Add pure-function unit tests for parsePosixLsof and parseWindowsNetstat with canned/edge-case string fixtures (no live exec/spawn needed) before this CLI is relied on for a Linux eval shard cleanup. Optional: one-line comment acknowledging the bounded TOCTOU residual window, and a note on locale-dependence of the LISTENING match.

