---
id: SLICE-445
title: "Extend backfill core to the project column and the sessions table, dry-run only"
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
  - src/tag-hygiene/repo-identity-backfill.ts
  - src/cli/repo-identity-backfill.ts
  - src/cli/index.ts
  - tests/tag-hygiene/repo-identity-backfill.test.ts
wave: 2
depends_on:
  - SLICE-442
  - SLICE-443
wave_attempts: 0
pending_fix: false
---
# SLICE-445: Extend backfill core to the project column and the sessions table, dry-run only

Implements FEAT-553. See [feature file](../../../backlog/in-progress/FEAT-553.md) for product context.

## Objective

Fix provenance leak: Claude Code agent-worktree directory names (agent-<id>) stored as memory `project` (and sometimes `repo`). Claude Code runs isolated agents in <repo>/.claude/worktrees/agent-<id>/; every astramem-plugin hook (session-end-summary.sh, subagent-stop-capture.sh, pre-compact-capture.sh) sets PROJECT_ID="$(basename "$CWD")" and POST /ingest/transcript stores project_id verbatim into sessions, so 17,877 of 119,950 memories (15%, verified 2026-11-05) carry project like agent-a0112287d8dd8d401 — 270 bogus "projects" pollute the dashboard project filter (SELECT DISTINCT project FROM memories, src/server/queries/dashboard.ts:276). repo leaks the same way for ~5/11 affected sessions (git toplevel of a worktree is the worktree dir). The daemon's deriveWorktreeSafeBasename() (src/pipeline/cwd-basename.ts) only knows the <name>-worktrees/<x> layout and only runs as a fallback when the client sent no project. Scope: (a) daemon ingest hardening — when project_id equals basename(cwd) and cwd is inside a .claude/worktrees/<x> (or <name>-worktrees/<x>) path, re-derive project/repo from the main repo root; extend deriveWorktreeSafeBasename to handle .claude/worktrees/<x>; (b) one-off backfill (migration or maintenance CLI) of the affected sessions + memories rows from sessions.cwd/repo, idempotent, with dry-run + count report; (c) cross-repo issue in astragenie/astramem-plugin for the hook-side fix (derive project from `git rev-parse --git-common-dir` or strip /.claude/worktrees/<x>), referenced as owner/repo#N. Acceptance: no memory or session row has project or repo matching ^agent-[0-9a-f]{17}$ after backfill; a new ingest from a cwd under .claude/worktrees/agent-x yields project = repo basename; dashboard project dropdown shows only real projects; tests for cwd-basename and ingest derivation.

## In scope

- `src/tag-hygiene/repo-identity-backfill.ts`: generalise `runRepoIdentityBackfill` to a `column: 'repo' | 'project'` option (default `'repo'` keeps FEAT-484 behaviour byte-identical for every row `git` can resolve; per DEC-017 rule (4), a row `git` cannot resolve now gets the SAME trust-gated string-heuristic parity check `project` always had, instead of automatically falling to `unresolved` — this is an intentional, decision-backed widening of the default's behavior for exactly that edge case, not a regression; see the DELETED-WORKTREE STRING FALLBACK / GENUINE NEVER-GUESS tests) and an `includeSessions` option that re-stamps `sessions.<column>` for the same session ids; resolver = `resolveRepoIdentity(cwd) ?? deriveWorktreeSafeBasename(cwd)` per DEC-017 rules (1)/(4); keep reasons `no-session` / `no-cwd` / `unresolved` and `joiningExistingCount` (AC-4).
- `src/cli/repo-identity-backfill.ts` + the help text in `src/cli/index.ts`: add `--column repo|project|all` and `--sessions`; preview stays the DEFAULT, `--yes` required to mutate; preview prints scanned / would-re-stamp / unresolved + per-candidate merge blast radius; two consecutive dry-runs produce identical counts (AC-6); print repo-root basenames, never absolute cwd paths (AC-9).
- `tests/tag-hygiene/repo-identity-backfill.test.ts`: project-column cases, sessions re-stamp, deleted-worktree string fallback, never-guess cases, idempotent second run, `--column all`.

## Out of scope

- Running against the production datadir: SLICE-447 (operator-gated) owns that; this slice is code + tests only.
- `src/server/routes/ingest.ts` (SLICE-444), migrations (no schema change), auto-apply without `--yes`.

## Acceptance criteria

> ACs scoped to this slice: AC-4, AC-6, AC-8, AC-9 (the remaining FEAT-553 ACs are owned by sibling slices; see the wave plan).

- [ ] AC-4: Given a memories row whose project matches DEFAULT_BAD_REPO_PATTERN (src/tag-hygiene/repo-identity-backfill.ts:59) but whose sessions.cwd is NULL, or whose session_id is NULL, or whose cwd contains no recoverable .claude/worktrees/<x> or <name>-worktrees/<x> segment, When the extended backfill runs, Then that row is left unmutated and counted in unresolved with reason 'no-session', 'no-cwd', or 'unresolved', so the FEAT-484 never-guess guard at src/tag-hygiene/repo-identity-backfill.ts:19-26 is preserved and no assume-the-usual-repo fallback is introduced.
- [ ] AC-6: Given the extended backfill CLI is invoked WITHOUT --yes against a datadir seeded with bogus-project rows, When it completes, Then zero rows are mutated, the preview reports scanned, would-re-stamp, and unresolved counts plus each candidate's joiningExistingCount merge blast radius, and a second identical invocation reports byte-identical counts, proving the idempotent-no-op property the existing harness claims.
- [ ] AC-8: Given the backfill has been applied with --yes, When SELECT COUNT(*) FROM memories WHERE project GLOB 'agent-*' and the same query against sessions are run, and /dashboard is loaded, Then both counts equal the backfill's reported unresolved count and no higher, and the dashboard project dropdown fed by queryProjectOptions (src/server/queries/dashboard.ts:276) lists only resolvable project names plus any explicitly-unresolved remainder, so every remaining row is accounted for rather than silently left behind.
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
