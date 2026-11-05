---
id: SLICE-442
title: Extend deriveWorktreeSafeBasename for nested .claude/worktrees/<x> + contract tests
status: pending
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
touches_files:
  - src/pipeline/cwd-basename.ts
  - tests/pipeline/cwd-basename.test.ts
wave: 1
depends_on: []
wave_attempts: 0
pending_fix: false
---
# SLICE-442: Extend deriveWorktreeSafeBasename for nested .claude/worktrees/<x> + contract tests

Implements FEAT-553. See [feature file](../../../backlog/in-progress/FEAT-553.md) for product context.

## Objective

Fix provenance leak: Claude Code agent-worktree directory names (agent-<id>) stored as memory `project` (and sometimes `repo`). Claude Code runs isolated agents in <repo>/.claude/worktrees/agent-<id>/; every astramem-plugin hook (session-end-summary.sh, subagent-stop-capture.sh, pre-compact-capture.sh) sets PROJECT_ID="$(basename "$CWD")" and POST /ingest/transcript stores project_id verbatim into sessions, so 17,877 of 119,950 memories (15%, verified 2026-11-05) carry project like agent-a0112287d8dd8d401 — 270 bogus "projects" pollute the dashboard project filter (SELECT DISTINCT project FROM memories, src/server/queries/dashboard.ts:276). repo leaks the same way for ~5/11 affected sessions (git toplevel of a worktree is the worktree dir). The daemon's deriveWorktreeSafeBasename() (src/pipeline/cwd-basename.ts) only knows the <name>-worktrees/<x> layout and only runs as a fallback when the client sent no project. Scope: (a) daemon ingest hardening — when project_id equals basename(cwd) and cwd is inside a .claude/worktrees/<x> (or <name>-worktrees/<x>) path, re-derive project/repo from the main repo root; extend deriveWorktreeSafeBasename to handle .claude/worktrees/<x>; (b) one-off backfill (migration or maintenance CLI) of the affected sessions + memories rows from sessions.cwd/repo, idempotent, with dry-run + count report; (c) cross-repo issue in astragenie/astramem-plugin for the hook-side fix (derive project from `git rev-parse --git-common-dir` or strip /.claude/worktrees/<x>), referenced as owner/repo#N. Acceptance: no memory or session row has project or repo matching ^agent-[0-9a-f]{17}$ after backfill; a new ingest from a cwd under .claude/worktrees/agent-x yields project = repo basename; dashboard project dropdown shows only real projects; tests for cwd-basename and ingest derivation.

## In scope

- `src/pipeline/cwd-basename.ts`: add a SECOND string-only rule: when the path's last three segments are `.claude/worktrees/<x>`, return the segment before `.claude` (e.g. `/c/work/mega/astramem-local/.claude/worktrees/agent-a0112287d8dd8d401` -> `astramem-local`; Windows separators too). Keep the FEAT-425 `<name>-worktrees/<x>` rule; evaluate the nested rule first, then the sibling rule, then plain basename.
- Stay STRING-ONLY: no `fs`, no `child_process`, no git (the FEAT-425 AC-3 contract in the file header; AC-2 here).
- `tests/pipeline/cwd-basename.test.ts`: add nested-shape cases (POSIX + Windows + trailing slash + `.claude` not at depth 3 => passthrough); every pre-existing case passes unmodified (AC-3). Update the file-header comment describing the recognised shapes.

## Out of scope

- `src/pipeline/derive-project.ts`, `src/server/routes/ingest.ts`, anything under `src/tag-hygiene/`: SLICE-444 / SLICE-445 own those and depend on this slice landing first.
- Any behaviour change for paths that are not one of the two worktree shapes.

## Acceptance criteria

> ACs scoped to this slice: AC-2, AC-3 (the remaining FEAT-553 ACs are owned by sibling slices; see the wave plan).

- [ ] AC-2: Given deriveWorktreeSafeBasename (src/pipeline/cwd-basename.ts) is called with /c/work/mega/astramem-local/.claude/worktrees/agent-a0112287d8dd8d401 and no git repository exists at that path because the worktree was already deleted, When it returns, Then the value is 'astramem-local', derived from the path string alone with no git spawn and no fs.stat call, preserving the FEAT-425 AC-3 string-only contract documented in that file's header.
- [ ] AC-3: Given the three input shapes the current heuristic is contracted on - a plain checkout /c/work/mega/astramem-local, the sibling convention /c/work/mega/astramemory-local-worktrees/wt-423b, and a root-only or empty path - When deriveWorktreeSafeBasename is called on each after the change, Then it returns 'astramem-local', 'astramemory-local', and null respectively, and every pre-existing cwd-basename test case passes unmodified so the FEAT-425 AC-2 conservative passthrough is not regressed.

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
