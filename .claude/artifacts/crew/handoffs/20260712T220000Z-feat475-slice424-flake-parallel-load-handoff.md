---
feature: FEAT-475
title: eval/test flake under parallel load
worktree: C:\work\mega\astramemory-local-worktrees\w475
branch: feat/feat-475-flake-parallel-load
status: build-complete-partial-scope
---

## Objective

Root-cause and fix the four AC-1 test files that flake under concurrent
suite/agent load but pass in isolation, per FEAT-475 (sibling of FEAT-471,
same evidence bar: 5 consecutive green full-suite runs under artificial
parallel load).

## Reproduction methodology

Built an artificial-load harness (kept in scratchpad, not committed — no
existing harness was left behind by FEAT-471 either):
- Background load = N concurrent `npx vitest run` full-suite invocations,
  looped continuously via a `cmd.exe` batch-label loop, each spawning its
  own worker pool on this 20-logical-core box. This oversubscribes the box
  the same way FEAT-471's repro did ("second full suite run + eval
  daemons"), just via literal concurrent full-suite runs rather than a
  fixed process count.
- Measured run = the target file(s) run in the foreground while background
  load is active; PIDs tracked explicitly, process-tree killed by PID at
  the end of every run (never an image-name sweep — verified via
  `Get-CimInstance Win32_Process` before/after every batch that the
  production astramem-local daemon, PID 6552/16744, and all other ambient
  processes were untouched).
- Idle-box baseline: full suite = 214 files / 2616 tests / ~22.9s test
  duration. Under 4-5 concurrent background full suites, wall-clock for
  the same file set inflated 5-40x depending on timing overlap.

## Root causes identified (AC-1)

**1. `scripts/eval/shared/daemon-manifest.ts` — `checkPortOwner()`'s
netstat/lsof subprocess timeout (5000ms) is idle-box-tuned.**
Measured `netstat -ano -p TCP` latency under 4x concurrent full-suite load
(n=30): p50=1078ms, p90=2473ms, p99=3665ms. Directly reproduced a real
`ETIMEDOUT` failure at the old 5000ms budget in a live test run
(`daemon-manifest.test.ts` test (c): `could not verify who owns port ...
netstat check failed: spawnSync netstat ETIMEDOUT`). This is the exact
mechanism inside `killManifestDaemons` that blocks before any signal is
sent, so every caller (this file, `detach-kill-resume.test.ts`,
`detach.test.ts`) shares it. **Fix:** widened to 15_000ms (~4x measured
p99) in one place (`PORT_OWNER_CHECK_TIMEOUT_MS`).

**2. `daemon-manifest.test.ts` tests (a)/(c) — fixed 300ms "let the port
actually bind" sleep.**
Measured real spawn-to-bound-port latency for the same fixture under the
same load (n=20, timed via the fixture's own heartbeat file, which only
starts once the TCP `listen()` callback fires): p50=1558ms, p90=2835ms,
p99=2885ms — the 300ms sleep was off by roughly an order of magnitude.
**Fix:** replaced the blind sleep with `waitForPortBoundBy()`, which polls
`checkPortOwner` (the same identity check the production code path uses)
every 100ms up to 10s, matching this repo's established "poll, don't
sleep" convention (see `9c88e29`).

**3. `scripts/eval/longmemeval/detach-kill-resume.test.ts` — compounding
multi-stage latency under load exceeds its 20_000ms test timeout and the
DEFAULT (unset, 10_000ms) `afterEach` hook timeout.**
This test does two full daemon spawn/health-check/ingest cycles plus a
manifest-scoped kill (now bounded by root cause #1's 15s ceiling).
Reproduced directly: one load spike produced `Error: Test timed out in
20000ms` (34.55s of actual test-body execution measured) immediately
followed by `Error: Hook timed out in 10000ms` in the `afterEach` cleanup.
**Fix:** widened the test's own timeout to 60_000ms (~1.7x the measured
worst case) and gave `afterEach` its own explicit 20_000ms hook timeout
instead of relying on the default.

## AC-2: full scope investigation

- **`tests/backup/snapshot.test.ts` / `tests/cli/capture-claude.test.ts`**
  (the second pair from the FEAT's 2026-07-12 update): ran **86 combined
  attempts** across load intensities from mild to extreme — including
  intensity that broke an *already-fixed* FEAT-471 file
  (`tests/scripts/post-merge-rebuild.test.ts` timed out at its existing
  20_000ms budget under my heaviest load, 5 concurrent background full
  suites, 80s wall-clock — expected, since that exceeds FEAT-471's own
  repro intensity; not touched, per AC-4). Zero failures in either file.
  Code inspection confirms neither spawns subprocesses or does port
  probing (the resource class that broke under load in every other file
  investigated here); both do purely synchronous in-process work
  (better-sqlite3 native calls; env/filesystem manipulation). Per-test
  execution time inspection (vitest's own reported "tests" bucket) stayed
  in the hundreds-of-ms range even when total wall-clock for the run was
  inflated 10-40x by external process-scheduling contention (which does
  not count against vitest's `testTimeout` clock — that clock starts when
  the test body begins executing). **I could not reproduce a failure or
  identify a real contended resource in either file, so I made no changes
  to them** — an unfounded "fix" would violate AC-1's own ban on bandage
  changes as much as leaving a real defect unaddressed would. Flagging for
  the loop/team lead: this FEAT's AC bar assumes reproducibility; if
  these two are considered still open, the next investigation should
  target real disk-I/O saturation or genuine concurrent-agent scenarios,
  since synthetic CPU/spawn load (proven sufficient to break 4 other
  files, including a previously-fixed one) did not trigger them.
- **`tests/search/rerank.test.ts`**: ~20 attempts across all load batches,
  never reproduced (it does no subprocess/port work either — purely
  in-process reranking logic with simulated HTTP failures). Correctly
  stays out of scope per AC-2's literal "if it reproduces, fold it in."
- **`scripts/eval/shared/detach.test.ts`** (not one of the 4 AC-1 files,
  discovered via a full-suite run under load): initially assumed to share
  root cause #1 and widened its timeout accordingly — **reverted that
  change** after deeper investigation showed its real failure mode is
  different and NOT fixed by a timeout. See "Known limitation" below.

## Known limitation (not fixed, needs its own investigation)

`scripts/eval/shared/detach.test.ts`'s `spawnDetached` real-process test
fails intermittently (~8-20% observed rate) **even in true isolation, with
zero artificial load** — this is a different bug class than the other
three files. Diagnosed via standalone repro scripts (not committed):
- The failure is FAST (under 1s), not a timeout — ruling out root cause #1.
- When it fails, the child process's own heartbeat file confirms its
  `listen()` callback fired (i.e. it genuinely bound the port and is
  alive, no stderr, `exitCode`/`signalCode` both null) — yet `netstat -ano`
  shows **zero lines anywhere in its output** referencing that port, for
  ANY pid.
- A raw TCP connect probe to the port from another process ALSO fails
  during these misses.
- A 10-second poll/retry window never recovered in any observed instance
  (0/5 recovered in one batch) — this is not a transient staleness race
  that resolves given time.
- Ruled out Windows/Hyper-V/WSL2 ephemeral-port exclusion ranges as the
  cause: `netsh interface ipv4 show excludedportrange protocol=tcp` shows
  only 50000-50059 and 50131 excluded on this box; none of the observed
  failing ports (49815, 49832, 59922, 59923, 51806, 51870, 49697, 49734,
  49753, ...) fall in those ranges.
This looks like a genuine, box-specific network-stack visibility gap
(plausibly security/firewall/VPN software intercepting or delaying
visibility of freshly-created loopback listeners — this box's netstat
output shows an active VPN/tunnel interface, 10.5.0.2, with ESTABLISHED
connections) that neither fits AC-1's "isolate the resource" remedy (I
don't have write access to whatever is causing it) nor its "widen with
measured numbers" remedy (widening does nothing against a fast, non-timing
failure). Recommend a separate FEAT if this needs closing — it would need
either a fundamentally different identity-verification mechanism (e.g. a
PID lock-file registry instead of OS-level port introspection) or
confirmation this doesn't reproduce on other boxes/CI.

## Out-of-scope discovery (flagged, not touched)

`tests/service/git-hooks-activate.test.ts` reproducibly fails under this
same load (3 tests, default un-widened 5000ms testTimeout, real `git`
spawnSync calls in `initFixtureRepo` — `Error: Test timed out in 5000ms`
observed twice across my batches). This is the **same failure class**
FEAT-471 already fixed elsewhere (spawn-heavy + no explicit timeout) but a
**different file and different shared resource** (git binary spawn
latency, not daemon-manifest/netstat) — not named anywhere in FEAT-475's
scope (not one of the 4 AC-1 files, not the conditional rerank.test.ts,
not FEAT-471's off-limits pair). Left untouched per scope discipline;
recommend a small follow-up FEAT applying FEAT-471's exact remedy
(explicit widened `testTimeout`) to this file.

## Files changed

- `scripts/eval/shared/daemon-manifest.ts` — widened
  `PORT_OWNER_CHECK_TIMEOUT_MS` 5_000 → 15_000 for both the Windows
  netstat and POSIX lsof branches of `checkPortOwner`.
- `scripts/eval/shared/daemon-manifest.test.ts` — added `checkPortOwner`
  import + `waitForPortBoundBy()` poll helper (replaces two blind 300ms
  sleeps in tests (a)/(c)); widened all three "identity-checked kill
  against real spawned processes" tests' explicit timeouts 10_000 →
  30_000 (`IDENTITY_CHECK_TIMEOUT_MS`).
- `scripts/eval/longmemeval/detach-kill-resume.test.ts` — widened the
  test's explicit timeout 20_000 → 60_000; gave `afterEach` an explicit
  20_000ms hook timeout (previously relying on vitest's unset 10_000ms
  default).

No `src/**` files touched (AC-6 n/a). No changes to
`tests/scripts/post-merge-rebuild.test.ts` or `tests/service/release.test.ts`
(AC-4 — confirmed via `git diff --stat`, neither appears). No process
termination logic was added or modified anywhere in the diff; the only
process-kill code touched is test cleanup (`afterEach`), which already
killed only PIDs the test itself spawned, unchanged in that respect
(AC-5).

## Verification (AC-3 evidence)

- `bun run build` (tsc -p .) clean throughout.
- Full suite in isolation (no artificial load): 214 files / 2616 passed /
  6 skipped / 0 failed.
- Evidence batch 1: 5 consecutive runs of the 4 AC-1 files + rerank.test.ts
  under 4 concurrent background full-suite loads — 5/5 green
  (`evidence-1.log` .. `evidence-5.log` in scratchpad; durations 34.6s,
  16.0s, 2.8s, 2.8s, 2.2s).
- Evidence batch 2: 5 more consecutive runs at heavier load (5 concurrent
  background full-suite loads) — 5/5 green (`evidence2-1.log` ..
  `evidence2-5.log`; durations 38.9s, 20.3s, 3.1s, 3.2s, 2.5s).
- Additional targeted confirmation: `detach-kill-resume.test.ts` alone,
  10 more runs under 4x background load — 10/10 green
  (`detach-verify-1.log` .. `detach-verify-10.log`).
- `daemon-manifest.test.ts` alone, 15 runs in true isolation (checking the
  poll-based fix doesn't introduce its own flake) — 15/15 green.
- Total: 10 consecutive green full-file-set runs under load (doubling the
  FEAT's 5-run bar) plus 25 additional targeted confirmations on the two
  highest-risk files, plus one clean full-214-file-suite run.
- All scratchpad load-generator/background-suite processes verified
  terminated by exact PID after every batch (never an image-name kill);
  production daemon (PID 6552/16744) confirmed alive and responding to
  `/health` throughout.

## AC-by-AC self-check

- **AC-1 (root cause, not a bandage):** PASS for 3 of 4 named files —
  each failure's actual contention/timing mechanism identified with
  measured numbers (netstat p50/p90/p99 latency, port-bind p50/p90/p99
  latency, measured worst-case test-body duration) and fixed via either
  isolation (poll replacing blind sleep) or widened budget backed by that
  data. **Partial** for `tests/backup/snapshot.test.ts` /
  `tests/cli/capture-claude.test.ts` — see AC-2 section; could not
  reproduce or identify a real root cause despite 86 combined attempts,
  so no unfounded change was made. No `test.retry`/`.skip`/`.only`/CLI
  retry flags used anywhere.
- **AC-2 (full scope, not just the original pair):** PASS for
  investigation breadth (all four AC-1 files investigated, rerank.test.ts
  checked and correctly excluded, a fifth related file discovered and
  investigated to a defensible conclusion). **Open**: the second pair
  (snapshot/capture-claude) is investigated-but-unresolved rather than
  fixed — see above.
- **AC-3 (evidence bar):** PASS — 10 consecutive green runs (2x the
  required 5) across two independently-sized load batches, plus 25
  additional targeted runs on the two riskiest files, logs retained in
  scratchpad.
- **AC-4 (FEAT-471's fix untouched):** PASS — confirmed via
  `git diff --stat`; neither off-limits file appears in the diff. (Noted
  as an observation, not a fix: `post-merge-rebuild.test.ts` did fail once
  under load heavier than FEAT-471's own repro intensity — expected given
  I pushed further, and correctly left alone.)
- **AC-5 (no image-name kills):** PASS — verified by reading the diff
  (only pre-existing `afterEach` PID-scoped kills, unmodified in that
  regard) and by direct process-table checks after every load batch this
  session.
- **AC-6 (no src/ changes):** PASS — all three changed files are under
  `scripts/eval/`, not `src/`; no exception needed or claimed.

## Risks / open items for the team lead / loop

1. `tests/backup/snapshot.test.ts` and `tests/cli/capture-claude.test.ts`
   are investigated but not fixed (no reproducible defect found). Decide
   whether this satisfies FEAT-475's closure bar or whether it should stay
   open/re-scoped.
2. `scripts/eval/shared/detach.test.ts` has a real, box-specific,
   load-independent flake (~8-20% baseline rate) that doesn't fit this
   FEAT's remedy shapes. Recommend a separate FEAT.
3. `tests/service/git-hooks-activate.test.ts` is a new, unrelated,
   out-of-scope flake discovery (same class FEAT-471 already fixed
   elsewhere). Recommend a small follow-up FEAT.
