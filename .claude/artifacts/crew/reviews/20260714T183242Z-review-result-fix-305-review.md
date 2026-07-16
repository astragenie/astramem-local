---
findings: "🔴:0,🟡:2,❓:1"
status: completed
decision: approved_with_notes
author_id: unknown-builder
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Review Result

- Created: 2026-07-14T18:38:08.128Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: Reviewed commit 4bb670a (fix/bun-resolve-npm-fallback-305, PR #324) in worktree fix-305.
Scope: src/service/release.ts (+78/-4), tests/service/resolve-install-command.test.ts (new, 52 lines).
Note: git diff main...HEAD showed 113 files because this worktree's local `main` ref is stale relative
to the branch tip; the actual PR content is isolated to commit 4bb670a (verified via `git show --stat`).

Verdict: approved_with_notes. Fix correctly resolves the #305 ENOENT root cause (spawnSync cannot
execute a non-native `bun` shim on Windows) with a proper --version probe rather than existsSync alone,
falls back to `npm install --omit=dev` with shell:true scoped to fixed literal args (no injection),
and leaves the two pre-existing runCaptured call sites (boot-verify, release.ts:445/473) unaffected
since the new `shell` param defaults to false (confirmed via grep — only the new call site at line 403
passes pm.shell). tsc --noEmit clean; `bunx vitest run tests/service/resolve-install-command.test.ts
tests/service/release.test.ts` — 10/10 pass, and release.test.ts's materializeRelease e2e exercises the
new resolver for real (unmocked, real bun on this box) with no regression.

Findings (most severe first):

[MEDIUM] tests/service/resolve-install-command.test.ts:36-51 — the "prefers bare bun on PATH" test's
own comment claims it exercises the bare-PATH fallback branch specifically ("the ~/.bun/bin candidate
does not exist on the runner"), but that assumption is never enforced: node:fs's existsSync is NOT
mocked in this file, only node:child_process's spawnSync is. If bun is actually installed at the
official ~/.bun/bin/bun.exe location on the CI/dev box (plausible — this very box has a working bun,
confirmed by release.test.ts's real `bun install` passing in seconds), the test would silently take
the ~/.bun/bin branch instead of the bare-PATH branch. The assertions (`kind==='bun'`, args contain
`--frozen-lockfile`, `shell===false`) are IDENTICAL for both branches (only `cmd.cmd` differs — an
absolute path vs the literal string `'bun'`), and `cmd.cmd` is never asserted. Net effect: the
BUN_INSTALL > ~/.bun/bin > bare-PATH candidate preference order that resolveInstallCommand's own
docstring promises is not actually pinned down by any test — a future refactor that silently breaks
the ordering would not be caught. Fix: assert `expect(cmd.cmd).toBe('bun')` for the intended branch,
and mock `existsSync` from node:fs (same rigor already applied to spawnSync) to deterministically force
each of the three candidate branches, including a dedicated BUN_INSTALL-set case which currently has
zero coverage.

[MEDIUM] src/service/release.ts:403 — the npm fallback reuses BUN_INSTALL_TIMEOUT_MS (5 min, unchanged)
rather than a wider npm-specific bound. npm dependency resolution + install is typically slower than a
bun frozen-lockfile install (no lockfile-fast-path equivalent — this is a fresh production resolve per
the PR's own commit message), and Windows Defender/AV file-scan overhead on a large fresh node_modules
can add meaningfully. If npm legitimately needs >5 min on a slow box, runCaptured hard-times-out and
throws — reproducing the exact "reinstall aborts and never touches the service" failure class this PR
exists to fix, just one level further down the fallback chain, with no test coverage for this timeout
interaction either. Not incorrect as shipped, but worth a deliberate NPM_INSTALL_TIMEOUT_MS (larger than
5 min) rather than implicitly inheriting bun's bound, and calling it out in the PR/backlog.

[LOW] src/service/release.ts:196-206 (bunRuns) — the probe is "did `<path> --version` exit 0", not "is
this genuinely the oven-sh bun binary". A hypothetical JS/npm-distributed `bun`-named compat shim that
happens to answer --version successfully (but isn't semantically compatible with `bun.lock` /
--frozen-lockfile) would pass the probe and get selected, then fail later at `bun install
--frozen-lockfile` with an error shape unrelated to the original ENOENT this PR fixes. Still strictly
better than the pre-fix crash (a clear, scoped install-failure error rather than a silent daemon
lifecycle abort), so not blocking — flagging as a residual edge case worth a one-line acknowledgment
if it isn't already implicitly accepted.

Answers to the six review-focus questions:
1. Candidate order/bunRuns probe is correct for the stated failure mode (a plain-script `bun` on PATH
   with no runnable extension → spawnSync sets res.error, bunRuns returns false, correctly falls
   through). See [LOW] above for the one shim scenario that could still pass the probe.
2. npm fallback is safe (shell:true + fixed literal args, no injection); --omit=dev is the modern
   equivalent of the deprecated --production flag and correctly excludes devDependencies; loss of
   frozen-lockfile determinism is clearly warned via both a code comment and a runtime console.warn,
   and the thrown error on install failure correctly names which command variant ran.
3. runCaptured's new shell param defaults to false; confirmed via grep that the two pre-existing call
   sites (release.ts:445, 473 — boot-verify) don't pass it, so their behavior is unchanged. The
   separate inline spawnSync('git', ...) at release.ts:270 doesn't go through runCaptured at all and is
   untouched by this diff.
4. .exe suffix handling is correct and symmetric with the real bun installer's install layout on both
   platforms (win32: bun.exe under $BUN_INSTALL/bin and ~/.bun/bin; posix: bare bun). No posix
   regression — verified the exe variable and join() calls are platform-branched correctly.
5. Test 1 (no-bun → npm fallback) is fully deterministic regardless of the runner's real filesystem
   state, since spawnSync is entirely mocked to always fail — existsSync's real-fs result doesn't
   matter. Test 2 has the candidate-order gap described in the MEDIUM finding above. release.test.ts's
   materializeRelease e2e (10 tests total across both files, all green) passes through the new resolver
   unmodified and unmocked — confirms no regression on a real-bun box.
6. See MEDIUM finding above — 5 min is inherited unchanged for npm and could plausibly be tight on a
   slow/cold Windows box; not proven broken, flagged as a follow-up.

Confidence: high — read the full diff (git show 4bb670a), traced all runCaptured/spawnSync call sites
in the file via grep, ran tsc --noEmit (clean) and the two named test files (10/10 pass, including the
real unmocked e2e), and reasoned through Windows CreateProcess/.cmd-shim spawn semantics for the core
claim in the commit message.
- Evidence Checked:
  - git show 4bb670a (full diff read); grep confirmed only new call site (release.ts:403) passes shell param
  - pre-existing sites (445
  - 473) unaffected; tsc --noEmit exit 0
  - 0 errors; bunx vitest run tests/service/resolve-install-command.test.ts tests/service/release.test.ts -> 2 files
  - 10/10 passed
  - 9.83s
- Files Reviewed:
  - src/service/release.ts
  - tests/service/resolve-install-command.test.ts
- Test Adequacy: New unit test file covers no-bun->npm-fallback deterministically (full spawnSync mock); the bun-found branch test doesn't mock existsSync or assert cmd.cmd, so it can't distinguish which of the 3 candidates matched -- BUN_INSTALL and the exact preference order are untested. Existing materializeRelease e2e (release.test.ts) passes unmodified through the new resolver, unmocked, confirming no regression on a real-bun box.
- Author: unknown-builder
- Judge: crew:reviewer
- Risks: npm fallback reuses bun's 5min timeout unadjusted (untested, plausibly tight on slow/cold Windows boxes); bunRuns probe accepts any --version-answering binary named bun, not verified-real-bun (low-probability shim edge case, still strictly better than pre-fix crash)
- Required Follow-up: Add existsSync mocking + cmd.cmd assertions to resolve-install-command.test.ts to actually pin the BUN_INSTALL > ~/.bun/bin > PATH preference order (currently unverified); consider a dedicated NPM_INSTALL_TIMEOUT_MS wider than BUN_INSTALL_TIMEOUT_MS for the fallback path

