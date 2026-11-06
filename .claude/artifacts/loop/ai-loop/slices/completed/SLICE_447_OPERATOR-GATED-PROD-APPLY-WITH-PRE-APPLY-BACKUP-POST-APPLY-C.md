---
id: SLICE-447
title: Operator-gated prod apply with pre-apply backup + post-apply count verification
status: completed
feature: FEAT-553
phase: null
priority: P1
target_release: null
requires_validation: true
risk: high
created: 2026-11-05
updated: 2026-11-06
effort_points: 1
estimated_tokens: 60000
touches_files: [docs/runbooks/provenance-backfill.md]
wave: 3
depends_on: [SLICE-444, SLICE-445]
wave_attempts: 0
pending_fix: false
completed_at: 2026-11-06
---
# SLICE-447: Operator-gated prod apply with pre-apply backup + post-apply count verification

Implements FEAT-553. See [feature file](../../../backlog/in-progress/FEAT-553.md) for product context.

## Objective

Fix provenance leak: Claude Code agent-worktree directory names (agent-<id>) stored as memory `project` (and sometimes `repo`). Claude Code runs isolated agents in <repo>/.claude/worktrees/agent-<id>/; every astramem-plugin hook (session-end-summary.sh, subagent-stop-capture.sh, pre-compact-capture.sh) sets PROJECT_ID="$(basename "$CWD")" and POST /ingest/transcript stores project_id verbatim into sessions, so 17,877 of 119,950 memories (15%, verified 2026-11-05) carry project like agent-a0112287d8dd8d401 — 270 bogus "projects" pollute the dashboard project filter (SELECT DISTINCT project FROM memories, src/server/queries/dashboard.ts:276). repo leaks the same way for ~5/11 affected sessions (git toplevel of a worktree is the worktree dir). The daemon's deriveWorktreeSafeBasename() (src/pipeline/cwd-basename.ts) only knows the <name>-worktrees/<x> layout and only runs as a fallback when the client sent no project. Scope: (a) daemon ingest hardening — when project_id equals basename(cwd) and cwd is inside a .claude/worktrees/<x> (or <name>-worktrees/<x>) path, re-derive project/repo from the main repo root; extend deriveWorktreeSafeBasename to handle .claude/worktrees/<x>; (b) one-off backfill (migration or maintenance CLI) of the affected sessions + memories rows from sessions.cwd/repo, idempotent, with dry-run + count report; (c) cross-repo issue in astragenie/astramem-plugin for the hook-side fix (derive project from `git rev-parse --git-common-dir` or strip /.claude/worktrees/<x>), referenced as owner/repo#N. Acceptance: no memory or session row has project or repo matching ^agent-[0-9a-f]{17}$ after backfill; a new ingest from a cwd under .claude/worktrees/agent-x yields project = repo basename; dashboard project dropdown shows only real projects; tests for cwd-basename and ingest derivation.

## In scope

- OPERATOR-GATED, not autonomous. Write `docs/runbooks/provenance-backfill.md`, then execute it with the operator present.

## Runbook

See `docs/runbooks/provenance-backfill.md` — contains the full operator playbook: backup, preview, go/no-go gate, apply, verify (AC-8), write-back, rollback.
- Preconditions: SLICE-444 + SLICE-445 merged; `bun run build` + `node dist/cli/index.js reinstall` so the RUNNING daemon carries the ingest override (otherwise bogus rows keep arriving until the plugin fix lands); confirm `ls migrations | tail -1` matches the installed release (checkout-CLI-migrates-prod footgun, docs/memory.md 2026-11-05).
- Steps: (1) `node dist/cli/index.js backup` and note the snapshot path; (2) `node dist/cli/index.js repo-identity-backfill --column all --sessions --json > preview.json`, record scanned / would-re-stamp / unresolved; (3) operator confirms; (4) rerun with `--yes`; (5) verify: `SELECT COUNT(*) FROM memories WHERE project GLOB 'agent-*'` and the same on `sessions` both equal the reported unresolved count (AC-8), `/dashboard` project dropdown shows no `agent-*` entries beyond those, `doctor` green on handler run-log; (6) write the final numbers into `docs/memory.md`. Rollback: `node dist/cli/index.js restore <snapshot>`.

## Out of scope

- Any code change. Running without a verified backup. Running while SLICE-444's daemon release is not live.

## Acceptance criteria

> ACs scoped to this slice: AC-4, AC-6, AC-8 (the remaining FEAT-553 ACs are owned by sibling slices; see the wave plan).

- [ ] AC-4: Given a memories row whose project matches DEFAULT_BAD_REPO_PATTERN (src/tag-hygiene/repo-identity-backfill.ts:59) but whose sessions.cwd is NULL, or whose session_id is NULL, or whose cwd contains no recoverable .claude/worktrees/<x> or <name>-worktrees/<x> segment, When the extended backfill runs, Then that row is left unmutated and counted in unresolved with reason 'no-session', 'no-cwd', or 'unresolved', so the FEAT-484 never-guess guard at src/tag-hygiene/repo-identity-backfill.ts:19-26 is preserved and no assume-the-usual-repo fallback is introduced.
- [ ] AC-6: Given the extended backfill CLI is invoked WITHOUT --yes against a datadir seeded with bogus-project rows, When it completes, Then zero rows are mutated, the preview reports scanned, would-re-stamp, and unresolved counts plus each candidate's joiningExistingCount merge blast radius, and a second identical invocation reports byte-identical counts, proving the idempotent-no-op property the existing harness claims.
- [ ] AC-8: Given the backfill has been applied with --yes, When SELECT COUNT(*) FROM memories WHERE project GLOB 'agent-*' and the same query against sessions are run, and /dashboard is loaded, Then both counts equal the backfill's reported unresolved count and no higher, and the dashboard project dropdown fed by queryProjectOptions (src/server/queries/dashboard.ts:276) lists only resolvable project names plus any explicitly-unresolved remainder, so every remaining row is accounted for rather than silently left behind.

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
