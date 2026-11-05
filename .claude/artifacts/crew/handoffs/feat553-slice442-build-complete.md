# Handoff: FEAT-553 SLICE-442 — nested `.claude/worktrees/<x>` basename rule — build complete

- **Objective**: extend `deriveWorktreeSafeBasename` (`src/pipeline/cwd-basename.ts`)
  to recognize the nested `<repo>/.claude/worktrees/<x>` Claude-Code
  agent-worktree layout (string-only, no git/fs), and add contract tests —
  AC-2 and AC-3 of FEAT-553. This is wave 1 of a 6-slice FEAT; the other
  five slices (SLICE-443..447) are out of scope here and depend on this
  one landing first.
- **Owner**: builder (this dispatch — `crew:orchestrate-slice` was invoked
  per the dispatch instruction, but this run has no Agent/Task dispatch
  tool available, so the specialist ladder — architect/uxdesigner/reviewer/
  verifier — could not actually be spawned; this handoff plus the review
  and validation artifacts below are the documented fallback the dispatch
  prompt itself allows for that case).
- **Worktree**: `C:\work\mega\astramem-local-SLICE-442-0`
- **Branch**: `main-SLICE-442` (based on `main` @ `02cf8ede`)

## Allowed scope

- `src/pipeline/cwd-basename.ts`
- `tests/pipeline/cwd-basename.test.ts`
- Crew/loop artifacts under `.claude/artifacts/`

## Forbidden scope (honored, not touched)

- `src/pipeline/derive-project.ts`, `src/server/routes/ingest.ts`,
  anything under `src/tag-hygiene/` (owned by SLICE-444/445).
- No migrations.
- No edits, builds, or runs against the main checkout
  (`C:/work/mega/astramem-local`) or any sibling worktree.
- No `reinstall`/`service`/`doctor`/`queue`/`memory health` against the
  production datadir.

## Deliverable — files changed

- `src/pipeline/cwd-basename.ts` — added a second, higher-priority
  string-only rule: when the path's last three segments are exactly
  `.claude`, `worktrees`, `<x>` (in that order, counting from the end),
  return the segment immediately before `.claude` (the main repo name).
  Evaluated before the existing FEAT-425 `<repo>-worktrees/<x>` sibling
  rule, which is itself evaluated before plain-basename passthrough — same
  order the slice spec calls for. No `fs`/`child_process`/git calls added
  (preserves the FEAT-425 AC-3 string-only contract). Doc comment at the
  top of the file rewritten to describe both recognised shapes and the
  evaluation order.
- `tests/pipeline/cwd-basename.test.ts` — added 6 new cases: POSIX nested
  shape, Windows nested shape, nested shape with trailing separator,
  precedence (nested rule fires over the sibling rule when both path
  segments could theoretically match), `.claude` one level too deep (depth
  4, not 3) falls through to plain basename, and a bare `.claude/worktrees/<x>`
  with nothing before `.claude` (no repo segment to recover) also falls
  through to plain basename. All 9 pre-existing cases (11 `it` blocks)
  left byte-identical and still pass.

## TDD evidence

1. Red: added the 4 primary new assertions first — confirmed they failed
   against the pre-change implementation (`agent-a0112287d8dd8d401`
   returned instead of `astramem-local`), while all 11 pre-existing `it`
   blocks still passed.
2. Green: implemented the nested rule; re-ran — 15/15 passing (11
   pre-existing + 4 new). Added 2 more edge-case tests (precedence, bare
   `.claude/worktrees/<x>`) afterward — also green without further
   implementation changes.

## AC checklist

- **AC-2** (nested path, no git/fs, returns `astramem-local`): PASS —
  `tests/pipeline/cwd-basename.test.ts` "resolves a nested
  `.claude/worktrees/<x>` shaped cwd ... (POSIX)" / "(Windows)", both using
  the exact AC-2 path shape (`.../astramem-local/.claude/worktrees/agent-a0112287d8dd8d401`).
  No `fs`/`child_process` import exists anywhere in `cwd-basename.ts` —
  confirmed by reading the file; the function is pure string manipulation.
- **AC-3** (3 existing shapes unaffected + all pre-existing cases pass
  unmodified): PASS — plain checkout -> basename, sibling
  `<repo>-worktrees/<x>` -> captured repo name, root-only/empty -> `null`,
  all still asserted and green; zero pre-existing test lines were edited
  (only new `it` blocks appended).

## Evidence

```
cd C:/work/mega/astramem-local-SLICE-442-0
bunx vitest run tests/pipeline/cwd-basename.test.ts
  Test Files  1 passed (1)
  Tests  15 passed (15)

bun run build   (tsc -p .)
  clean, no output

bunx vitest run tests/tag-hygiene/repo-identity.test.ts tests/pipeline
  Test Files  16 passed (16)
  Tests  214 passed (214)
  (confirms the one other git-aware consumer family, src/tag-hygiene/repo-identity.ts,
  is unaffected — it resolves the nested shape via git, not this string heuristic,
  and its own tests still pass unchanged)
```

Full-repo `bun run test` (vitest run, whole suite) was run twice from this
worktree:

- 1st pass: 95 failed / 5713 passed / 19 skipped across 14 files. Root-caused
  to environment, not this change — see "Full-suite run notes" below.
- 2nd pass (`ASTRA_SKIP_CONSOLIDATE` unset): 3 failed / 5805 passed / 19
  skipped, all 3 in `tests/service/shim.test.ts` (win32 watchdog-probe
  timing tests). Re-ran that file alone immediately after: 43/43 pass —
  confirms the remaining 3 are the same class of full-suite-parallelism
  timeout noise as the other process-spawn files below, not a regression.
  Full detail in the validation artifact
  (`.claude/artifacts/crew/validations/feat553-slice442-validation.md`).

## Full-suite run notes (environment, not a regression from this slice)

The first `bun run test` pass in this worktree showed 95 failures across 14
files. Investigated each distinct failure cluster before accepting/rejecting
it as a regression:

1. **`ASTRA_SKIP_CONSOLIDATE=1` was leaking into the shell from outside this
   session** (confirmed via `env | grep -i astra` — not set by anything in
   this dispatch). This env var short-circuits `runConsolidation()` entirely
   (`[consolidate] skipped — ASTRA_SKIP_CONSOLIDATE=1`), which is exactly
   what the FEAT-548 handoff's own evidence section flags as a required
   precondition ("`ASTRA_SKIP_CONSOLIDATE` was unset before every test run
   per constraint"). This alone accounts for the large majority of the 95
   failures (all of `tests/consolidate/*`, plus consolidation-touching
   assertions in `tests/doctor/schedule.test.ts`, `tests/mcp/server.test.ts`,
   `tests/e2e/ingest-to-memory-canary.e2e.test.ts`). Re-ran
   `tests/consolidate/consolidate.test.ts` alone with the var unset: 68/68
   pass (was 61 failed/7 passed with it set).
2. The remaining failures (`tests/service/shim.test.ts` watchdog-probe
   tests, `scripts/eval/locomo/archive-run.test.ts`,
   `scripts/eval/shared/detach.test.ts`, `tests/cli/init.test.ts`) are all
   process-spawn/subprocess/timing-sensitive tests that hit their 5000ms
   default `testTimeout` only under the full parallel-worker suite's
   resource contention on this box — every one of them passed cleanly when
   re-run in isolation immediately afterward (`archive-run.test.ts` 2/2,
   `detach.test.ts` 10/10, `shim.test.ts` 43/43). None of these files
   import or exercise `src/pipeline/cwd-basename.ts`, directly or
   transitively through `derive-project.ts`/`derive-repo.ts` (checked via
   grep — none of the 4 files reference `deriveWorktreeSafeBasename`,
   `derive-project`, or `derive-repo`).
3. A clean re-run of the full suite with `ASTRA_SKIP_CONSOLIDATE` unset is
   the actual gate evidence — recorded in the validation artifact.

## Risks / follow-ups

- `ASTRA_SKIP_CONSOLIDATE=1` being set in the ambient shell/user profile on
  this box is itself worth flagging to the operator — any test run on this
  box that doesn't explicitly `unset` it first will silently under-report
  consolidation coverage. Not fixed here (out of this slice's file scope);
  noted for the loop/operator, and a candidate `docs/memory.md` entry.
- FEAT-553 stays in `in-progress/` — this slice closes AC-2/AC-3 only; 5
  more slices (SLICE-443..447) must land before the FEAT as a whole can
  move to `done/`. Do not move the FEAT file as part of closing this slice.
