---
id: SLICE-444
title: Ingest-side project_id override at the 3 session-upsert call sites + override log event
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
  - src/pipeline/derive-project.ts
  - src/server/routes/ingest.ts
  - tests/pipeline/derive-project.test.ts
  - tests/tag-hygiene/worktree-ingest-canary.test.ts
  - tests/server/ingest.test.ts
wave: 2
depends_on:
  - SLICE-442
  - SLICE-443
wave_attempts: 0
pending_fix: false
---
# SLICE-444: Ingest-side project_id override at the 3 session-upsert call sites + override log event

Implements FEAT-553. See [feature file](../../../backlog/in-progress/FEAT-553.md) for product context.

## Objective

Fix provenance leak: Claude Code agent-worktree directory names (agent-<id>) stored as memory `project` (and sometimes `repo`). Claude Code runs isolated agents in <repo>/.claude/worktrees/agent-<id>/; every astramem-plugin hook (session-end-summary.sh, subagent-stop-capture.sh, pre-compact-capture.sh) sets PROJECT_ID="$(basename "$CWD")" and POST /ingest/transcript stores project_id verbatim into sessions, so 17,877 of 119,950 memories (15%, verified 2026-11-05) carry project like agent-a0112287d8dd8d401 — 270 bogus "projects" pollute the dashboard project filter (SELECT DISTINCT project FROM memories, src/server/queries/dashboard.ts:276). repo leaks the same way for ~5/11 affected sessions (git toplevel of a worktree is the worktree dir). The daemon's deriveWorktreeSafeBasename() (src/pipeline/cwd-basename.ts) only knows the <name>-worktrees/<x> layout and only runs as a fallback when the client sent no project. Scope: (a) daemon ingest hardening — when project_id equals basename(cwd) and cwd is inside a .claude/worktrees/<x> (or <name>-worktrees/<x>) path, re-derive project/repo from the main repo root; extend deriveWorktreeSafeBasename to handle .claude/worktrees/<x>; (b) one-off backfill (migration or maintenance CLI) of the affected sessions + memories rows from sessions.cwd/repo, idempotent, with dry-run + count report; (c) cross-repo issue in astragenie/astramem-plugin for the hook-side fix (derive project from `git rev-parse --git-common-dir` or strip /.claude/worktrees/<x>), referenced as owner/repo#N. Acceptance: no memory or session row has project or repo matching ^agent-[0-9a-f]{17}$ after backfill; a new ingest from a cwd under .claude/worktrees/agent-x yields project = repo basename; dashboard project dropdown shows only real projects; tests for cwd-basename and ingest derivation.

## In scope

- `src/pipeline/derive-project.ts`: export `reconcileIngestProject({ projectId, cwd, repo })` -> `{ project, overridden, source }` implementing DEC-017 rule (2): override only when `projectId === basename(cwd)` AND the derived value (`repo` if git-resolved, else `deriveWorktreeSafeBasename(cwd)` from SLICE-442) differs; otherwise return `projectId` untouched.
- `src/server/routes/ingest.ts`: apply it at the THREE session-upsert call sites (canonical v1 path ~L468, spool/async path ~L782, legacy envelope ~L996; legacy has no cwd, so it is a no-op there) and emit one structured log event per override: `{ msg: 'ingest project_id overridden', original, derived, source, session_id }` with basenames only (AC-7, AC-9).
- Tests: `tests/pipeline/derive-project.test.ts` (reconcile rules incl. explicit-label passthrough), `tests/tag-hygiene/worktree-ingest-canary.test.ts` (extend the FEAT-484 canary to also assert `sessions.project`; AC-1), `tests/server/ingest.test.ts` (AC-5 verbatim label; AC-7 log event fields).

## Out of scope

- `src/pipeline/cwd-basename.ts` (landed in SLICE-442: consume, do not edit), `src/tag-hygiene/*` (SLICE-445), `contracts/` (no wire-schema change: `project_id: z.string()` stays), the dashboard.
- Backfilling existing rows: SLICE-445 / SLICE-447.

## Acceptance criteria

> ACs scoped to this slice: AC-1, AC-5, AC-7, AC-9 (the remaining FEAT-553 ACs are owned by sibling slices; see the wave plan).

- [ ] AC-1: Given a canonical v1.0 POST /ingest/transcript envelope whose cwd is C:\work\mega\astramem-local\.claude\worktrees\agent-a0112287d8dd8d401 and whose project_id is the string agent-a0112287d8dd8d401, When the daemon executes the sessions upsert at src/server/routes/ingest.ts:468, Then the stored sessions row has project = 'astramem-local' and repo = 'astramem-local', and neither column equals agent-a0112287d8dd8d401.
- [ ] AC-5: Given an ingest envelope whose cwd is a worktree path but whose project_id is a deliberate different label that does NOT equal basename(cwd), When the sessions upsert runs, Then project_id is stored verbatim and is not overridden, so the re-derivation fires only on the hook-produced basename shape and never clobbers an intentional project label.
- [ ] AC-7: Given the ingest-side re-derivation overrides a client-sent project_id, When the override fires, Then a structured log event is emitted carrying the original value, the re-derived value, and the derivation source as either 'git-common-dir' or 'string-heuristic', so the override rate and which path resolved it are measurable from daemon logs with no DB query.
- [ ] AC-9: Given the override log event of AC-7 and the backfill preview output of AC-6 both report a filesystem location that may embed the operator's home-directory name, When either is emitted, Then the location appears as the derived repo-root basename rather than a full absolute path, consistent with the repo's existing redaction posture (src/redact/) and the client-scrub wire contract.

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
