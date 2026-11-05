---
id: SLICE-446
title: Cross-repo astramem-plugin hook issue + docs/memory.md write-back
status: pending
feature: FEAT-553
phase: null
priority: P1
target_release: null
requires_validation: true
risk: high
created: 2026-11-05
updated: 2026-11-05
effort_points: 1
estimated_tokens: 60000
touches_files:
  - docs/memory.md
wave: 1
depends_on: []
wave_attempts: 0
pending_fix: false
---
# SLICE-446: Cross-repo astramem-plugin hook issue + docs/memory.md write-back

Implements FEAT-553. See [feature file](../../../backlog/in-progress/FEAT-553.md) for product context.

## Objective

Fix provenance leak: Claude Code agent-worktree directory names (agent-<id>) stored as memory `project` (and sometimes `repo`). Claude Code runs isolated agents in <repo>/.claude/worktrees/agent-<id>/; every astramem-plugin hook (session-end-summary.sh, subagent-stop-capture.sh, pre-compact-capture.sh) sets PROJECT_ID="$(basename "$CWD")" and POST /ingest/transcript stores project_id verbatim into sessions, so 17,877 of 119,950 memories (15%, verified 2026-11-05) carry project like agent-a0112287d8dd8d401 — 270 bogus "projects" pollute the dashboard project filter (SELECT DISTINCT project FROM memories, src/server/queries/dashboard.ts:276). repo leaks the same way for ~5/11 affected sessions (git toplevel of a worktree is the worktree dir). The daemon's deriveWorktreeSafeBasename() (src/pipeline/cwd-basename.ts) only knows the <name>-worktrees/<x> layout and only runs as a fallback when the client sent no project. Scope: (a) daemon ingest hardening — when project_id equals basename(cwd) and cwd is inside a .claude/worktrees/<x> (or <name>-worktrees/<x>) path, re-derive project/repo from the main repo root; extend deriveWorktreeSafeBasename to handle .claude/worktrees/<x>; (b) one-off backfill (migration or maintenance CLI) of the affected sessions + memories rows from sessions.cwd/repo, idempotent, with dry-run + count report; (c) cross-repo issue in astragenie/astramem-plugin for the hook-side fix (derive project from `git rev-parse --git-common-dir` or strip /.claude/worktrees/<x>), referenced as owner/repo#N. Acceptance: no memory or session row has project or repo matching ^agent-[0-9a-f]{17}$ after backfill; a new ingest from a cwd under .claude/worktrees/agent-x yields project = repo basename; dashboard project dropdown shows only real projects; tests for cwd-basename and ingest derivation.

## In scope

- Open a GitHub issue in `astragenie/astramem-plugin` (hooks `session-end-summary.sh`, `subagent-stop-capture.sh`, `pre-compact-capture.sh` set PROJECT_ID to the basename of CWD; proposed fix: `git -C "$CWD" rev-parse --git-common-dir` -> parent dir basename, fallback strip `/.claude/worktrees/<x>` and `/<name>-worktrees/<x>`); reference it as `astragenie/astramem-plugin#N` in FEAT-553's body (`.claude/artifacts/loop/backlog/in-progress/FEAT-553.md`, append a `## Cross-repo` line).
- `docs/memory.md`: supersede the 2026-11-05 'Provenance leak' known-gap entry in place with FEAT-553 slice status, the issue link, and the DEC-017 policy; refresh its date.
- If `gh` is not authenticated, write the full issue text into `docs/memory.md` under the same entry and mark the slice `blocked: gh auth` instead of inventing an issue number.

## Out of scope

- Any change inside the plugin repo checkout (`C:/work/mega/astramemory-plugin`): issue only. Any source change in this repo.

## Acceptance criteria

- [ ] AC-S1: Given this slice's In-scope deliverable, When the reviewer reads it, Then every item listed under In scope exists as described and nothing under Out of scope was touched.

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
