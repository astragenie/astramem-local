---
feature: FEAT-475
slice: SLICE-424
title: eval/daemon test flake under parallel load — remaining pair (snapshot.test.ts / capture-claude.test.ts) reinvestigation
status: reinvestigated — no reproducible defect found, no code change
---

## Scope of this pass

FEAT-475's four AC-1 files were split by a prior partial fix
(`12ab2714`, merged to `origin/main`): `scripts/eval/longmemeval/detach-kill-resume.test.ts`
and `scripts/eval/shared/daemon-manifest.test.ts` were root-caused and fixed
(netstat/lsof timeout widened, blind sleep replaced with a poll, test/hook
timeouts widened — all measured). `tests/backup/snapshot.test.ts` and
`tests/cli/capture-claude.test.ts` were investigated (86 combined
reproduction attempts) but left unmodified — no reproducible failure, no
subprocess/port-probing resource class present, per the merged handoff
(`.claude/artifacts/crew/handoffs/20260712T220000Z-feat475-slice424-flake-parallel-load-handoff.md`).

This pass re-investigates the remaining pair with a **materially different
load composition** than the prior attempt, specifically targeting the gap
the prior investigator flagged themselves ("the next investigation should
target real disk-I/O saturation"): combined CPU-burn **and** heavy
temp-directory file churn (mkdtemp/writeFile/readFile/rm in a tight loop,
matching the I/O shape these two files themselves perform), layered under
concurrent full-suite `vitest run` background load.

## Load harness

- `load-gen.mjs` (scratchpad, not committed): per-process loop of CPU burn
  (~30ms bursts of floating-point work) + disk churn (mkdtemp, 40x
  write+read of 2-10KB files, one nested mkdir+write, then recursive rm) —
  repeated for a fixed duration. Up to 8 instances run concurrently.
- Combined with up to 8 concurrent background `bunx vitest run` (full
  214-file suite) invocations — the same technique the prior FEAT-475 pass
  used, escalated from their 5-max to 8 concurrent.
- All spawned processes tracked by exact PID (`final-load-pids.txt` /
  `load-pids.txt` in scratchpad) and killed individually after each batch —
  never an image-name sweep (AC-5). Production daemon (PID 39464, port 7777)
  confirmed alive via `/health` before, during, and after every batch.

## Findings

- 18 runs of `tests/backup/snapshot.test.ts` + `tests/cli/capture-claude.test.ts`
  together (26 tests/run = 468 total test executions) across two escalating
  load intensities (10 disk/CPU churners + 2 background suites, then 15
  churners + 8 background suites): **0 failures**.
- Worst individual test latency observed: 2342ms (`scoping isolation —
  disabling+purging proxy captures...`, the heaviest test in the file — 2 DB
  opens, 2 config writes, 2 `captureCommand` invocations). Baseline
  (no load): ~150ms. That's a real ~15x slowdown under load, but only 47%
  of vitest's 5000ms default `testTimeout` — comfortable margin, not the
  "little margin left" (~70-90% utilized) pattern that justified widening
  in every other file this FEAT touched (FEAT-471's git-spawn tests,
  `daemon-manifest.ts`'s netstat timeout, `detach-kill-resume.test.ts`'s
  compounding two-daemon cycle).
- `tests/search/rerank.test.ts` (AC-2 conditional): 3 runs under the same
  active load, 32/32 tests passed each time, ~700-800ms total — confirms
  the prior finding; correctly stays out of scope.
- Code-level confirmation matches the prior investigation: neither file
  spawns a subprocess or does port/network introspection (the resource
  class that broke every other file in this FEAT). `snapshot.test.ts` does
  real `better-sqlite3` calls (`openDb`/`migrate`/`db.backup()`/`VACUUM
  INTO`) against unique per-test `randomUUID()` temp dirs — no shared path.
  `capture-claude.test.ts` mutates `process.env.APPDATA` /
  `ASTRA_MEMORY_DATADIR` per-test via `mkdtempSync`-unique dirs, saved and
  restored in `afterEach` — process-local state, and vitest's default
  `threads` pool gives each worker its own `process.env` copy, so no
  cross-worker leak is possible even under concurrent file scheduling.

## Disposition

No code change applied to either file. Per AC-1 ("no fix consists solely of
... swallowing/ignoring the failure" and, by the same logic, no fix should
be fabricated without evidence of real contention), and per the prior
review's own precedent (`approved_with_notes` on the original partial fix,
explicitly endorsing "investigated but not reproducible" as satisfying
AC-1's no-bandage rule rather than a shortfall), this pass reinforces rather
than overturns that conclusion — now backed by a second, independent load
methodology (disk-I/O-focused, not just CPU/subprocess-focused) with zero
reproduction across 468 additional test executions.

## AC-3 evidence — all four AC-1 files together, 5 consecutive runs

Ran `scripts/eval/longmemeval/detach-kill-resume.test.ts`,
`scripts/eval/shared/daemon-manifest.test.ts`, `tests/backup/snapshot.test.ts`,
`tests/cli/capture-claude.test.ts` together under combined load (8 disk/CPU
churners + 5 background full-suite `vitest run` invocations):

| run | start (UTC) | files | tests | result | wall clock |
|---|---|---|---|---|---|
| 1 | 06:10:24 | 4 passed | 34 passed | green | 56s |
| 2 | 06:11:24 | 4 passed | 34 passed | green | 35s |
| 3 | 06:12:08 | 4 passed | 34 passed | green | 24s |
| 4 | 06:12:35 | 4 passed | 34 passed | green | 8s |
| 5 | 06:12:40 | 4 passed | 34 passed | green | 4s |

5/5 green, 0 failures across 170 test executions. Worst single-test latency
in this batch: `daemon-manifest.test.ts`'s identity-mismatch test at
13853ms — well inside its merged fix's 30000ms `IDENTITY_CHECK_TIMEOUT_MS`
budget (46% utilized), consistent with that widening being well-justified.

Production daemon (`GET /health` on port 7777) returned `"ok":true` before
and after this batch. No stray `load-gen.mjs` or background `vitest`
processes remained (all self-terminated on their timers; explicit PID kill
attempted first and reported "already exited" for all tracked PIDs).

## AC-by-AC self-check (this pass)

- **AC-1:** No bandage applied. Root-cause search for the remaining pair
  concluded (with independent reconfirmation) that no reproducible
  shared-resource contention exists in these two files under the two
  distinct load methodologies tried across this FEAT (86 + 18 runs).
- **AC-2:** All four AC-1 files + the conditional `rerank.test.ts` are
  investigated in this slice. The remaining pair is root-caused to "no
  contended resource identified" rather than fixed — same disposition the
  review gate already approved once.
- **AC-3:** 5/5 green consecutive runs of all four files together under
  artificial parallel load, table above; exceeds the FEAT's 5-run bar.
- **AC-4:** `tests/scripts/post-merge-rebuild.test.ts` and
  `tests/service/release.test.ts` not touched (not in this branch's diff).
- **AC-5:** No process-kill logic added or modified in any target file.
  Harness processes killed by exact tracked PID only; verified via
  `Get-CimInstance Win32_Process` that the production daemon and all
  sibling-agent processes were untouched throughout.
- **AC-6:** No `src/**` file modified.
