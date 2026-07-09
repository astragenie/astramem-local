---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result: Review Result

- Created: 2026-07-08T23:18:33.098Z
- Reviewer: reviewer
- Decision: approved_with_notes
- Status: completed
- Summary: FEAT-440 + FEAT-439 correctly implement crash-loop visibility and schema-drift detection with solid never-throw guarantees for the log-writing path, but the stdio piping change to spawnSync introduces a new, untested failure mode: default 1MB maxBuffer can SIGTERM-kill an otherwise-healthy long-running daemon.
- Evidence Checked:
  - git diff main...HEAD: 8 files
  - 990 insertions. bun install && bun run build clean (tsc -p . passes repo-wide). bunx vitest run tests/doctor tests/service tests/scripts: 19 files
  - 169/169 pass
  - matches builder claim. Empirically verified (node -e spawnSync repro): writing 2MB to a piped-stderr child under default spawnSync maxBuffer=1MB causes res.status=null
  - res.signal=SIGTERM
  - res.error.code=ENOBUFS — confirms shim.ts LAUNCHER_SOURCE's 'const res = spawnSync(ptr.nodeBin
  - args
  - { stdio: ["inherit"
  - "inherit"
  - "pipe"]
  - env });' (no maxBuffer override) can kill a healthy daemon that cumulatively writes >~1MB to stderr over its run (the shim's spawnSync blocks synchronously for the daemon's full uptime per the PT5M-keepalive architecture — potentially days/weeks). The resulting null-status exit maps to exitCode 1 in appendExitHistory
  - i.e. gets recorded as a generic crash and can feed false-positive AC-3 crash-loop RED alerts. AC-4's own never-throw test (tests/service/shim.test.ts:259) only covers the log-write path (mkdirSync failure via file-as-dir trick) — it does not cover the maxBuffer/pipe-kill path
  - which is a distinct failure mode not mentioned in FEAT-440's pre-mortem. Schema-drift wireMetaPath resolution verified against real dist/ layout (dist/server/lib/wire-meta.js
  - dist/cli/index.js both exist) — correct. Crash-loop streak logic (backward walk
  - stop at first exitCode===0) matches AC-3/AC-5 exactly and is well covered (7 tests incl. AC-5 fast-exit-resets-streak). post-merge-rebuild.mjs: try/catch-wrapped
  - main() never throws
  - loudFail() writes to stderr on any step failure (satisfies AC-3's 'stderr or equivalent' — never silently swallowed)
  - marker-file de-dup verified via real git repo fixtures (AC-4). Boundary check: git diff --name-only confirms only shim.ts
  - doctor/checks.ts
  - the two git-hooks scripts
  - and 4 test files changed — reinstall.ts/install-flow.ts/service.ts untouched
  - Lane A boundary respected.
- Files Reviewed:
  - src/service/shim.ts
  - src/doctor/checks.ts
  - scripts/git-hooks/post-merge
  - scripts/git-hooks/post-merge-rebuild.mjs
  - tests/doctor/crash-loop-check.test.ts
  - tests/doctor/schema-drift-check.test.ts
  - tests/scripts/post-merge-rebuild.test.ts
  - tests/service/shim.test.ts
- Test Adequacy: 169/169 tests pass across the scoped suites (doctor/service/scripts); AC-1 through AC-5 for both FEATs each have a dedicated, well-targeted test (ring-buffer truncation, crash.log capture+rolling cap, never-throw on unwritable logs dir, crash-loop streak incl. AC-5 fast-exit-reset, schema-drift GREEN/RED/fallback paths, post-merge de-dup via real git fixtures) — but no test covers the new stdio:'pipe' + spawnSync default-maxBuffer interaction identified below, which is the one real coverage gap.
- Risks: HIGH (see finding below): shim.ts's daemon-launching spawnSync uses stdio:['inherit','inherit','pipe'] with no maxBuffer override — Node defaults to 1MB, and exceeding it SIGTERM-kills the daemon (verified empirically), misrecorded as a generic crash and able to trigger false-positive crash-loop RED alerts. Current codebase's stderr-writing paths during healthy operation are mostly one-shot (instance-lock zombie-takeover warning once at boot, embed-preflight only warns on the FIRST failure not every retry, crash handlers are terminal) so the practical odds of tripping this under today's code are low, but it is an unbounded, uncontrolled risk (any future dependency/runtime warning chatter over weeks of uptime can tip it) with zero test coverage and directly contradicts this FEAT's own core promise ('the shim must never take the daemon down'). [HIGH] src/service/shim.ts LAUNCHER_SOURCE (~line 220, the 'const res = spawnSync(ptr.nodeBin, args, { stdio: ["inherit","inherit","pipe"], env });' line) — Risk: a healthy long-running daemon that cumulatively writes >~1MB to stderr over its uptime gets SIGTERM-killed by its own launcher's spawnSync buffer cap, an entirely new failure mode this change introduces (previously stdio:'inherit' had no such cap) and one the FEAT's stated assumption ('healthy runs write ~nothing to stderr') did not anticipate being unbounded over a multi-day/week process lifetime. Fix: add an explicit generous maxBuffer (e.g. 'maxBuffer: Infinity' or a bounded 16-32MB) to the spawnSync options in LAUNCHER_SOURCE; trivial, isolated, one-line, no other behavior changes. Everything else reviewed clean: log-write never-throw guarantee (AC-4) is correctly implemented and tested via a clever cross-platform file-as-directory trick; ring-buffer truncation to 50 entries and crash.log's 64KB rolling cap are both correct and tested; crash-loop consecutive-non-zero-with-zero-reset streak logic is correct and matches AC-3/AC-5 exactly; schema-drift check is read-only, correctly falls back through release-pinned -> dev-pinned -> repo-working-tree per FEAT-439's third candidate source, and does not false-positive on a fresh/unmigrated DB; post-merge hook is fully non-blocking-safe (try/catch-wrapped, loud stderr on failure, never reverts/blocks the merge) with correct marker-based de-dup verified against real git fixtures.
- Required Follow-up: Add maxBuffer override to the spawnSync call in shim.ts's LAUNCHER_SOURCE before merge (or as an immediate fast-follow) and add a regression test simulating >1MB cumulative stderr from a long-running child to lock in the fix; not blocking given the isolated one-line nature of the fix and the currently-low real-world trigger probability.

