---
id: FEAT-553
status: in-progress
priority: P1
category: feature
target_release: null
created: 2026-11-05
updated: 2026-11-05
depends_on: []
slices: [SLICE-442, SLICE-443, SLICE-444, SLICE-445, SLICE-446, SLICE-447]
derived_from: null
pm_customer_impact: 0.85
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.8
pm_technical_risk: 0.7
pm_dependency_depth: 0.3
pm_composite_priority: P1
pm_autonomous_safe: false
pm_reviewed: 2026-11-05
autonomous_safe: false
triage_notes: "P1: operator-verified 15% store corruption (17,877/119,950) that is the unfinished project-column half of CLOSED FEAT-484 - src/tag-hygiene/repo-identity-backfill.ts:117 only updates repo, and ingest.ts:468 stores the client project_id verbatim so deriveProject never runs; technical_risk 0.7 per the 0.6-0.8 band (data-shape change over 17,877 rows re-stamping consolidation grouping keys, rollback needs a backup not a revert, shared-helper cross-module reach); effort 0.62 maps to 8 points and fires the decomposition gate; autonomousSafe=false because the acceptance criterion requires an operator-gated prod mutation and the checkout-CLI-migrates-prod footgun is one day old, not because the ACs are vague; no close cost analog, nearest are multi-source aggregates at about $222."
proposed_slices:
  - id_suffix: -SLICE-1
    title: Extend deriveWorktreeSafeBasename for nested .claude/worktrees/<x> + contract tests
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-2
    title: "DEC: trust policy for string-derived project identity when the worktree is deleted"
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-3
    title: Ingest-side project_id override at the 3 session-upsert call sites + override log event
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-4
    title: "Extend backfill core to the project column and the sessions table, dry-run only"
    points: 2
    estimated_tokens: 100000
  - id_suffix: -SLICE-5
    title: Cross-repo astramem-plugin hook issue + docs/memory.md write-back
    points: 1
    estimated_tokens: 60000
  - id_suffix: -SLICE-6
    title: Operator-gated prod apply with pre-apply backup + post-apply count verification
    points: 1
    estimated_tokens: 60000
tags: [storage, api-change, workflow, test, docs]
needs_contract: false
needs_ux: false
started_at: 2026-11-05
slices_complete: [SLICE-443]
---
## Description

Fix provenance leak: Claude Code agent-worktree directory names (agent-<id>) stored as memory `project` (and sometimes `repo`). Claude Code runs isolated agents in <repo>/.claude/worktrees/agent-<id>/; every astramem-plugin hook (session-end-summary.sh, subagent-stop-capture.sh, pre-compact-capture.sh) sets PROJECT_ID="$(basename "$CWD")" and POST /ingest/transcript stores project_id verbatim into sessions, so 17,877 of 119,950 memories (15%, verified 2026-11-05) carry project like agent-a0112287d8dd8d401 — 270 bogus "projects" pollute the dashboard project filter (SELECT DISTINCT project FROM memories, src/server/queries/dashboard.ts:276). repo leaks the same way for ~5/11 affected sessions (git toplevel of a worktree is the worktree dir). The daemon's deriveWorktreeSafeBasename() (src/pipeline/cwd-basename.ts) only knows the <name>-worktrees/<x> layout and only runs as a fallback when the client sent no project. Scope: (a) daemon ingest hardening — when project_id equals basename(cwd) and cwd is inside a .claude/worktrees/<x> (or <name>-worktrees/<x>) path, re-derive project/repo from the main repo root; extend deriveWorktreeSafeBasename to handle .claude/worktrees/<x>; (b) one-off backfill (migration or maintenance CLI) of the affected sessions + memories rows from sessions.cwd/repo, idempotent, with dry-run + count report; (c) cross-repo issue in astragenie/astramem-plugin for the hook-side fix (derive project from `git rev-parse --git-common-dir` or strip /.claude/worktrees/<x>), referenced as owner/repo#N. Acceptance: no memory or session row has project or repo matching ^agent-[0-9a-f]{17}$ after backfill; a new ingest from a cwd under .claude/worktrees/agent-x yields project = repo basename; dashboard project dropdown shows only real projects; tests for cwd-basename and ingest derivation.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Acceptance criteria (Given-When-Then)

- AC-1: Given a canonical v1.0 POST /ingest/transcript envelope whose cwd is C:\work\mega\astramem-local\.claude\worktrees\agent-a0112287d8dd8d401 and whose project_id is the string agent-a0112287d8dd8d401, When the daemon executes the sessions upsert at src/server/routes/ingest.ts:468, Then the stored sessions row has project = 'astramem-local' and repo = 'astramem-local', and neither column equals agent-a0112287d8dd8d401.
- AC-2: Given deriveWorktreeSafeBasename (src/pipeline/cwd-basename.ts) is called with /c/work/mega/astramem-local/.claude/worktrees/agent-a0112287d8dd8d401 and no git repository exists at that path because the worktree was already deleted, When it returns, Then the value is 'astramem-local', derived from the path string alone with no git spawn and no fs.stat call, preserving the FEAT-425 AC-3 string-only contract documented in that file's header.
- AC-3: Given the three input shapes the current heuristic is contracted on - a plain checkout /c/work/mega/astramem-local, the sibling convention /c/work/mega/astramemory-local-worktrees/wt-423b, and a root-only or empty path - When deriveWorktreeSafeBasename is called on each after the change, Then it returns 'astramem-local', 'astramemory-local', and null respectively, and every pre-existing cwd-basename test case passes unmodified so the FEAT-425 AC-2 conservative passthrough is not regressed.
- AC-4: Given a memories row whose project matches DEFAULT_BAD_REPO_PATTERN (src/tag-hygiene/repo-identity-backfill.ts:59) but whose sessions.cwd is NULL, or whose session_id is NULL, or whose cwd contains no recoverable .claude/worktrees/<x> or <name>-worktrees/<x> segment, When the extended backfill runs, Then that row is left unmutated and counted in unresolved with reason 'no-session', 'no-cwd', or 'unresolved', so the FEAT-484 never-guess guard at src/tag-hygiene/repo-identity-backfill.ts:19-26 is preserved and no assume-the-usual-repo fallback is introduced.
- AC-5: Given an ingest envelope whose cwd is a worktree path but whose project_id is a deliberate different label that does NOT equal basename(cwd), When the sessions upsert runs, Then project_id is stored verbatim and is not overridden, so the re-derivation fires only on the hook-produced basename shape and never clobbers an intentional project label.
- AC-6: Given the extended backfill CLI is invoked WITHOUT --yes against a datadir seeded with bogus-project rows, When it completes, Then zero rows are mutated, the preview reports scanned, would-re-stamp, and unresolved counts plus each candidate's joiningExistingCount merge blast radius, and a second identical invocation reports byte-identical counts, proving the idempotent-no-op property the existing harness claims.
- AC-7: Given the ingest-side re-derivation overrides a client-sent project_id, When the override fires, Then a structured log event is emitted carrying the original value, the re-derived value, and the derivation source as either 'git-common-dir' or 'string-heuristic', so the override rate and which path resolved it are measurable from daemon logs with no DB query.
- AC-8: Given the backfill has been applied with --yes, When SELECT COUNT(*) FROM memories WHERE project GLOB 'agent-*' and the same query against sessions are run, and /dashboard is loaded, Then both counts equal the backfill's reported unresolved count and no higher, and the dashboard project dropdown fed by queryProjectOptions (src/server/queries/dashboard.ts:276) lists only resolvable project names plus any explicitly-unresolved remainder, so every remaining row is accounted for rather than silently left behind.
- AC-9: Given the override log event of AC-7 and the backfill preview output of AC-6 both report a filesystem location that may embed the operator's home-directory name, When either is emitted, Then the location appears as the derived repo-root basename rather than a full absolute path, consistent with the repo's existing redaction posture (src/redact/) and the client-scrub wire contract.

## Proposed slices (PM decomposition)

- SLICE-1: Extend deriveWorktreeSafeBasename for nested .claude/worktrees/<x> + contract tests (2 pts)
- SLICE-2: DEC: trust policy for string-derived project identity when the worktree is deleted (2 pts)
- SLICE-3: Ingest-side project_id override at the 3 session-upsert call sites + override log event (2 pts)
- SLICE-4: Extend backfill core to the project column and the sessions table, dry-run only (2 pts)
- SLICE-5: Cross-repo astramem-plugin hook issue + docs/memory.md write-back (1 pts)
- SLICE-6: Operator-gated prod apply with pre-apply backup + post-apply count verification (1 pts)

## Cross-repo

Hook-side fix for the `PROJECT_ID="$(basename "$CWD")"` pattern (`session-end-summary.sh`,
`subagent-stop-capture.sh`, `pre-compact-capture.sh`) filed as
`astragenie/astramem-plugin#68` (2026-11-05, SLICE-446). Proposed fix in the issue: derive
project identity from `git -C "$CWD" rev-parse --git-common-dir` (resolves correctly from
inside a linked worktree), falling back to a string strip of
`/.claude/worktrees/<x>` / `/<name>-worktrees/<x>` when git can't answer (worktree already
deleted). This repo's own ingest-side hardening (SLICE-442/443/444) is independent and does
not block on the plugin-side fix landing.
