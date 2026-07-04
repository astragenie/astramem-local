# Autonomous Loop — HARD RULES

Plugin-managed by `/runner:install`. Do not edit by hand.

## Autonomous Loop Instruction — HARD RULE

**Run autonomously until ALL acceptance criteria for the current slice are met. Do NOT ask the user for confirmation, clarification, or approval at any point during implementation. Do NOT stop after implementation — run review, fix all findings, run validation, then write artifacts and push. Only stop when every acceptance criterion is marked PASS with evidence (per `.claude/artifacts/loop/ai-loop/01-loop-control/EVIDENCE_RULES.md`), or the work is externally blocked (missing infrastructure, secret, or external dependency that cannot be resolved without the user). If blocked, state the blocker clearly and stop there.**

## Cross-Slice Continuation — HARD RULE

After all acceptance criteria for the current slice are PASS with evidence and all artifacts written, automatically pick the next unit of work — without user confirmation:

1. **Scan `.claude/artifacts/loop/specs/`** — for any spec with `status: approved` and empty `derived_features`, decompose it: `/runner:spec decompose --id SPEC-NNN --features "title 1; title 2; ..."`. New FEAT files land in `.claude/artifacts/loop/backlog/pending/`.
2. **Scan `.claude/artifacts/loop/backlog/pending/`** — if any pending entries exist, run `/runner:backlog triage` to fill `priority`, `category`, `target_release` heuristically and move each to `.claude/artifacts/loop/backlog/triaged/`.
3. **Pick the highest-priority triaged feature** — order P0 > P1 > P2 > P3; break ties by lowest FEAT-NNN id ascending (oldest wins). Promote it: `/runner:slice from-feature --id FEAT-NNN`.
4. **Begin the Wiggin Loop on the new slice.** Acceptance criteria, evidence, review per `.claude/artifacts/loop/ai-loop/01-loop-control/`.
5. **On slice close** — run the Slice Close Ceremony (next section). Do NOT skip — every artifact is part of the slice's evidence record.

If `.claude/artifacts/loop/backlog/pending/`, `.claude/artifacts/loop/backlog/triaged/`, and `.claude/artifacts/loop/specs/` are all empty/satisfied, confirm via `/runner:spec status` and stop. Never stop because the backlog "feels empty."

### Slice frontmatter — optional `phase` field

Slices carry two optional linkage fields:

- `feature: FEAT-NNN` — set automatically by `/runner:slice-from-feature` and `/runner:derive-slice`.
- `phase: <string|null>` — free-form phase identifier (`"1"`, `"2"`, `"beta"`). Defaults to `null`.

Both propagate to artifact filenames (`runs/phaseN-featNNN-sliceNN-*.md`) and frontmatter. Segments are tight (no dash inside `feat021`); null fields drop out. Artifact consumers should treat segments as optional and ordered.

Crew-CLI-written filenames (`reviews/`, `validations/`, `runs/run-brief-*`, `cost/*`) receive `--title "PHASEN FEATNNN SLICENN: ..."` — crew's slugifier handles the rest, preserving timestamps for uniqueness.

### Auto mode vs. legacy gating

`loop.marathonMode` in `.claude/loop.json` controls the active stop set (default `true` — auto mode on):

| Trigger                     | auto mode (default)          | legacy (marathonMode=false) |
| --------------------------- | ---------------------------- | ----------------------- |
| Backlog exhausted           | halt                         | halt                    |
| Crew `escalated_to_human`   | halt                         | halt                    |
| Warn-severity pattern alert | halt                         | halt                    |
| High-severity cost alert    | halt                         | halt                    |
| Iteration cap (default 25)  | advisory (snapshot only)     | halt                    |
| Crew soft `blocked` badge   | advisory (often self-clears) | halt                    |

Auto mode disables only the _gating_, not the _telemetry_. Iteration counter still increments; `stop-check` still reports `iterationCount`/`iterationCap`/`crewBlocked` in `snapshot`.

## Slice Start Ceremony — HARD RULE

Open every slice through the canonical start command **before** beginning acceptance-criteria work:

1. **Identify the next slice.** Check `docs/superpowers/plans/*.md` for unchecked `## Task N: SLICE_NN` headings first; else fall back to Cross-Slice Continuation.
2. **`/runner:slice start --id SLICE-NN`** — rotates `currentRun` via `crew write-run-brief`, seeds the goal from `## Objective`, rewrites `.claude/state/crew/slice-progress.md`.
3. **Inspect the return.** Confirm `runBrief.artifactPath` is populated and `workflow-state.json.currentRun.title` equals `SLICE-NN: <title>`. Surface errors and stop — do not proceed with a stale run.
4. **Dispatch `crew:builder` subagent.** The `slice start` return includes a `dispatchInstruction` — hand it to a `crew:builder` subagent. Builder owns implementation only; when it returns, dispatch `crew:reviewer`, then `crew:validator` if behavior changed. **Do not implement inline.**
5. **Wait for builder, reviewer, and validator reports**, then run the Slice Close Ceremony.

Exception: manual invocations may pass `--no-dispatch`. The autonomous loop should never pass `--no-dispatch`.

## Dispatch Discipline — HARD RULE

The autonomous loop is an **orchestrator**, not an implementer. Every code-bearing unit of work runs through a crew subagent:

| Situation                                                         | Dispatch                                                    |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Slice implementation (acceptance criteria work)                   | `crew:builder` subagent (parent loop gates review+validate) |
| Bug found during slice (test fail, regression, integration error) | `/crew:fix` subagent                                        |
| Independent code review pass                                      | `/crew:review` subagent (or the configured reviewer ladder) |
| Behavior validation when something is runnable                    | `/crew:validate` subagent                                   |
| Deployment / shipping a reviewed change                           | `/crew:ship` subagent                                       |
| Trivial inline fixup (typo, fixture path, single-line patch)      | Inline is fine — but log it in the run-brief                |

Pivot triggers — any of these means **stop, dispatch `/crew:fix`, then resume**:

- A review_result with `status: needs_fix`
- A validation_result with `status: fail`
- A build/test failure requiring a root-cause hunt (not a one-line patch)

When in doubt, prefer dispatch. A subagent run produces its own artifact trail; an inline patch hides in the loop's conversation and loses cost/grade attribution.

**Never use `caveman:*` agents for slice work.** They lack the full artifact protocol. Always use `crew:builder`, `crew:reviewer`, `crew:validator`, `crew:deployer`.

- **Dispatch budget.** Maximum {{dispatchLimits.maxSubagentsPerSlice}} subagent dispatches per slice. Inline execution for: single-file edits, test fixes, lint fixes, format fixes. Subagent dispatch only for bounded independent tasks (full build, review, validation). Each cold-start re-derives context — avoid unless the task genuinely benefits from isolation.

## Build Entry Points

Two ways to start work. Pick one per session — do **not** mix.

- **`/crew:build` (interactive, single slice).** Lead-driven, lighter ceremony. No `slice start` required; no run-brief mandatory. Slice Close Ceremony still applies if the change closes a slice.
- **Autonomous loop (unattended, multi-slice).** Full ceremony required. Slice Start → Wiggin Loop → Slice Close. Invoked via `/loop`, `ScheduleWakeup`, or `CronCreate`. Every slice must rotate `currentRun`.

Never run both simultaneously against the same branch — they race on `workflow-state.json`.

For one-glance visibility: `cat .claude/state/crew/slice-progress.md`.

## Slice Close Ceremony — HARD RULE

When every acceptance criterion is PASS with evidence, close the slice **before** picking up the next one. Manual file moves are NOT a substitute — they bypass artifact fan-out:

1. **`/runner:slice complete --id SLICE-NN`** — atomically moves the slice to `completed/`, moves the linked feature to `done/`, reconciles parent SPEC status, and fans out:
   - `.claude/artifacts/crew/handoffs/<timestamp>-slice-nn-complete.md`
   - `.claude/artifacts/crew/runs/<timestamp>-slice-nn-final-synthesis.md` (auto-emits cost-report + cost-advise)
   - `cost-report` via `hero-crew cost-slice` CLI as a redundant safety net
2. **`/runner:slice grade --id SLICE-NN`** + **`/runner:slice grade-write --id SLICE-NN`** — capture scores and lessons. Skipping grading loses the self-improvement signal.
3. **Inspect the ceremony return** — verify `handoff.handoffPath`, `synthesis.synthesisPath`, and `costReport.usd` are all populated. Fix any `{ error: ... }` before continuing.
4. **Apply Cross-Slice Continuation** to pick the next unit of work.

Expected artifact set per slice (all must exist before Cross-Slice Continuation):

- `reviews/` — written via `crew write-review-result`
- `validations/` — written via `crew write-validation-result`
- `runs/run-brief-*.md` — opened at slice start
- `runs/final-synthesis-*.md` — emitted by ceremony
- `handoffs/*.md` — emitted by ceremony
- `cost/*-cost-report-*.md` + `cost-insights/*-cost-advise-*.md` — auto-emitted

If any is missing for a closed slice, re-run the ceremony or invoke the missing `crew write-*` command before continuing.

## Phase Completion Gate — HARD RULE

When the last slice in a phase completes, run `/runner:phase-gate`. The plugin executes every stage in `.claude/loop.json` via `execFile` (no shell interpretation), captures output, and writes a single validation artifact under `.claude/artifacts/crew/validations/phase-<N>-gate-<date>.md`. Do NOT proceed to the next phase on FAIL. Do NOT hand-author the gate artifact.

## Worktree Parallelism — HARD RULE

Run concurrent features in sibling git worktrees — each has its own `.claude/state/crew/workflow-state.json`:

1. Create one worktree per branch: `git worktree add ../repo-feat-a feat-a`.
2. Copy or git-track `.claude/loop.json` per branch.
3. Run `/loop` independently in each worktree.

Cost attribution is auto-detected at close time: linked worktrees pass `--source-project <slug>`; single worktrees pass `--aggregate-all`. No manual flag needed.

Fleet view: `node hero-crew/scripts/crew.mjs fleet --repo "$PWD"` from any worktree.

Constraints: each worktree must be on its own branch. Never push from inside the autonomous loop. Never run `/crew:build` and the autonomous loop simultaneously on the same worktree.

## Tool Discipline

- **Prefer dedicated tools over Bash.** Use Read/Grep/Glob for file operations. Reserve Bash for shell-only operations (git, npm, build commands).
- **Pre-validate paths.** Before file operations, verify the target exists. A failed tool call costs tokens for the error response plus the retry.
- **No speculative commands.** Plan the exact command before dispatching. Check flag syntax against the tool's help output if unsure.
- **Target: <2% tool failure rate per slice.** Cost reports track `toolFailureRate`. Above 5% triggers a cost advisory.

## First Action — Starting the Loop

Read in this order, then pick the highest-priority PENDING slice:

1. `.claude/artifacts/loop/ai-loop/00-entry/MASTER_PROMPT.md` — persona, stack, mandatory reading
2. `.claude/artifacts/loop/ai-loop/backlog/approved-slices.md` — pick highest-priority PENDING slice
3. The slice file listed in `approved-slices.md` (under `.claude/artifacts/loop/ai-loop/slices/`)
4. `.claude/artifacts/loop/ai-loop/01-loop-control/WIGGIN_LOOP.md` — the loop sequence
5. `.claude/artifacts/loop/ai-loop/01-loop-control/EVIDENCE_RULES.md` — how to mark PASS / PARTIAL / FAIL / BLOCKED
6. `.claude/artifacts/loop/ai-loop/01-loop-control/STOP_CONDITIONS.md` — when the loop is allowed to stop
