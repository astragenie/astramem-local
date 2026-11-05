---
id: SLICE-443
title: "DEC: trust policy for string-derived project identity when the worktree is deleted"
status: completed
feature: FEAT-553
phase: null
priority: P1
target_release: null
requires_validation: true
risk: high
created: 2026-11-05
updated: 2026-11-05
effort_points: 2
estimated_tokens: 100000
touches_files: [.claude/artifacts/loop/decisions/DEC-017.md, .claude/artifacts/loop/decisions/README.md]
wave: 1
depends_on: []
wave_attempts: 0
pending_fix: false
completed_at: 2026-11-05
---
# SLICE-443: DEC: trust policy for string-derived project identity when the worktree is deleted

Implements FEAT-553. See [feature file](../../../backlog/in-progress/FEAT-553.md) for product context.

## Objective

Fix provenance leak: Claude Code agent-worktree directory names (agent-<id>) stored as memory `project` (and sometimes `repo`). Claude Code runs isolated agents in <repo>/.claude/worktrees/agent-<id>/; every astramem-plugin hook (session-end-summary.sh, subagent-stop-capture.sh, pre-compact-capture.sh) sets PROJECT_ID="$(basename "$CWD")" and POST /ingest/transcript stores project_id verbatim into sessions, so 17,877 of 119,950 memories (15%, verified 2026-11-05) carry project like agent-a0112287d8dd8d401 — 270 bogus "projects" pollute the dashboard project filter (SELECT DISTINCT project FROM memories, src/server/queries/dashboard.ts:276). repo leaks the same way for ~5/11 affected sessions (git toplevel of a worktree is the worktree dir). The daemon's deriveWorktreeSafeBasename() (src/pipeline/cwd-basename.ts) only knows the <name>-worktrees/<x> layout and only runs as a fallback when the client sent no project. Scope: (a) daemon ingest hardening — when project_id equals basename(cwd) and cwd is inside a .claude/worktrees/<x> (or <name>-worktrees/<x>) path, re-derive project/repo from the main repo root; extend deriveWorktreeSafeBasename to handle .claude/worktrees/<x>; (b) one-off backfill (migration or maintenance CLI) of the affected sessions + memories rows from sessions.cwd/repo, idempotent, with dry-run + count report; (c) cross-repo issue in astragenie/astramem-plugin for the hook-side fix (derive project from `git rev-parse --git-common-dir` or strip /.claude/worktrees/<x>), referenced as owner/repo#N. Acceptance: no memory or session row has project or repo matching ^agent-[0-9a-f]{17}$ after backfill; a new ingest from a cwd under .claude/worktrees/agent-x yields project = repo basename; dashboard project dropdown shows only real projects; tests for cwd-basename and ingest derivation.

## In scope

- Write `.claude/artifacts/loop/decisions/DEC-017.md` (format: copy `DEC-016.md` frontmatter: `id`, `created`, `status: active`, `decided_by`, `relates: FEAT-553, FEAT-484, FEAT-425`) deciding the trust policy for string-derived project/repo identity when git cannot answer (worktree already deleted):
-   (1) a string-derived value is TRUSTED only for the two tool-generated layouts `<repo>/.claude/worktrees/<x>` and `<repo>-worktrees/<x>`; any other unresolvable shape stays `unresolved` (FEAT-484 never-guess guard preserved).
-   (2) ingest overrides a client-sent `project_id` ONLY when it equals `basename(cwd)` (the hook-produced shape); an explicit different label is stored verbatim (FEAT-553 AC-5).
-   (3) every override / re-stamp is observable: log event with original, derived, and `source: 'git-common-dir' | 'string-heuristic'` (AC-7); paths appear as repo-root basenames, never absolute paths (AC-9).
-   (4) `repo` gets the same string fallback as `project` when git is unresolvable (FEAT-484 currently leaves those rows `unresolved`).
- Add the DEC-017 line to `.claude/artifacts/loop/decisions/README.md` if that file carries an index; use `/runner:decisions` to create the record if the skill is available.

## Out of scope

- Any source or test change: this slice is a decision record only; SLICE-444 and SLICE-445 implement it.

## Acceptance criteria

- [x] AC-S1: Given this slice's In-scope deliverable, When the reviewer reads it, Then every item listed under In scope exists as described and nothing under Out of scope was touched. Evidence: `.claude/artifacts/crew/reviews/feat553-slice443-dec017-review.md` (PASS), `.claude/artifacts/crew/validations/20261105T225200Z-validation-result-feat553-slice443-dec017.md` (pass).

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-553 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
