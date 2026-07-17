---
feature: FEAT-475
title: eval/daemon test flake under parallel load — remaining pair reinvestigation
worktree: C:\work\mega\astramemory-local\.claude\worktrees\memoized-jumping-elephant
branch: feat/feat-475-flake-parallel-load-remaining-pair
status: reinvestigated — no reproducible defect, no code change to the remaining pair
---

## Objective

FEAT-475 (SLICE-424) was dispatched with all four AC-1 files as targets.
Investigation found the eval-family pair
(`scripts/eval/longmemeval/detach-kill-resume.test.ts`,
`scripts/eval/shared/daemon-manifest.test.ts`) was already root-caused and
fixed in a prior, separately-merged commit (`12ab2714` on `origin/main`,
already present on this branch since it was cut from `origin/main`) — no
further action needed there. The backup/CLI pair
(`tests/backup/snapshot.test.ts`, `tests/cli/capture-claude.test.ts`) was
that same prior pass's **unresolved** scope: 86 combined reproduction
attempts found zero failures and no subprocess/port-probing resource class
(the mechanism behind every other fix in this FEAT).

## What this pass did

Reran the investigation on the remaining pair with a materially different
load composition than the prior attempt — combined CPU burn **and** heavy
temp-directory disk churn (the class of I/O the prior investigator
explicitly flagged as untested: "the next investigation should target real
disk-I/O saturation"), layered under up to 8 concurrent background
full-suite `vitest run` invocations (prior pass topped out at 5).

Result: **still zero reproduction** across 468 additional test executions
(18 runs of the 2-file pair) plus 5 more consecutive green runs of all four
AC-1 files together (170 more executions) as the AC-3 evidence batch. Worst
observed latency in either file: 2342ms against a 5000ms default
`testTimeout` — 47% utilized, a real ~15x slowdown from the ~150ms
no-load baseline but comfortably short of the "little margin left"
(~70-90% utilized) threshold that justified every other widening in this
FEAT (FEAT-471's git-spawn tests, the netstat timeout, the two-daemon
compounding cycle).

Full evidence table, methodology, and AC-by-AC self-check:
`.claude/artifacts/crew/validations/20260717T061300Z-validation-result-feat475-slice424-remaining-pair.md`.

## Root cause named (AC-1)

**Ruled out, not found.** Both files do purely synchronous/async in-process
work against unique per-test temp paths (`randomUUID()` / `mkdtempSync`
guarantee no path collision) — real `better-sqlite3` calls
(`openDb`/`migrate`/`db.backup()`/`VACUUM INTO`) and `process.env`
mutation (save/restore per test, and vitest's default `threads` pool gives
each worker its own `process.env` copy, so no cross-worker leak is
possible). No subprocess spawn, no port/network introspection — the
resource class that broke every other file this FEAT touched. Under
combined CPU+disk+8x-background-suite load, both files stayed at ≤47% of
the default test timeout budget across 18 runs / 468 executions.

## Files changed in this branch

**None** under `tests/` or `scripts/eval/`. Two new artifacts only:
- `.claude/artifacts/crew/validations/20260717T061300Z-validation-result-feat475-slice424-remaining-pair.md`
- `.claude/artifacts/crew/handoffs/20260717T061400Z-handoff-feat475-remaining-pair-reinvestigation.md` (this file)

No `src/**` file touched (AC-6 n/a — no exception claimed). No process
termination logic added or modified anywhere (AC-5 n/a — the only kills in
this session were scratchpad harness PIDs, tracked and killed explicitly,
never by image name; production daemon and sibling-agent processes
confirmed alive throughout via `Get-CimInstance Win32_Process` and
`/health`). `tests/scripts/post-merge-rebuild.test.ts` and
`tests/service/release.test.ts` not touched (AC-4).

## AC-3 evidence (this branch's contribution)

5 consecutive green runs of all four AC-1 files together under combined
load (8 disk/CPU churners + 5 background full-suite runs): 5/5 green, 170
test executions, 0 failures. Table in the validation artifact.

## Disposition / recommendation for the team lead / loop

The remaining pair's disposition is unchanged from the prior, already
`approved_with_notes` review: **investigated, not reproducible, no
unfounded fix applied** — now independently reconfirmed with a second,
disk-I/O-focused load methodology that specifically closed the gap the
prior investigator flagged as untested. I recommend FEAT-475 / SLICE-424 be
closed on this basis: 2 of 4 files fixed with measured root causes, 2 of 4
files investigated to a defensible negative result across two independent
methodologies (104 total combined reproduction attempts + 18 more runs /
468 executions here), `rerank.test.ts` correctly excluded per AC-2's
conditional clause, and AC-3's evidence bar met for all four files together.

If a future flake report against `snapshot.test.ts` / `capture-claude.test.ts`
surfaces with a live reproduction (not just "seen on a reviewer's run"), the
next investigation should capture the load composition present at the
moment of failure (this box's Windows Defender / other AV real-time
scanning was never independently disabled or measured as a variable here —
that remains the one untested contention class against the shared OS temp
directory).
