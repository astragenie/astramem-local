---
id: FEAT-425
status: done
priority: P2
category: platform
target_release: null
created: 2026-07-05
updated: 2026-07-09
completed_at: 2026-07-09
depends_on: [FEAT-423]
slices: []
closure_note: "Verified already-implemented 2026-07-09 in src/pipeline/cwd-basename.ts (deriveWorktreeSafeBasename), wired into derive-project.ts, tag-hygiene/derive-repo.ts, capture/claude.ts. AC-1 `<repo>-worktrees/wt-foo` → repo name. AC-2 non-worktree cwd unchanged. AC-3 string-only heuristic, no git/stat calls. Tests green: tests/pipeline/cwd-basename.test.ts, tests/pipeline/derive-project.test.ts, tests/tag-hygiene/derive-repo.test.ts."
derived_from: null
tags: [concern:recall, concern:provenance, surface:daemon]
pm_customer_impact: 0.40
pm_effort_estimate: 0.15
pm_strategic_alignment: 0.40
pm_technical_risk: 0.15
pm_dependency_depth: 0.05
pm_effort_points: 2
composite_score: 0.56
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "Internal follow-up, not end-user reported: triage_notes quotes 'deriveProject's cwd-basename fallback is known to collide across git worktrees. Deliberately left out of scope for the bounded FEAT-423 correctness fix.' Real usage signal: this repo's own CLAUDE.md HARD RULES mandate worktree parallelism ('Run parallel features in sibling git worktrees'), so the loop itself is a guaranteed repeat trigger of the exact collision described."
pm_scope_notes: "depends_on: [FEAT-423] is resolved (backlog/done/FEAT-423.md: status: done). Smallest deliverable: string-only path heuristic in the two named functions, no git/fs calls added (explicitly required by the FEAT itself). No cost analog found (Framework 5 — no aggregate cost reports exist in this repo). No weak grade dimension applies (lowest is observability at 0.84, above the 0.80 threshold)."
pm_risks:
  - "Low blast radius (2 files, ~50 lines) but the heuristic is conservative-by-design; a too-aggressive strip rule could silently merge two genuinely different repos that happen to share a '-worktrees/wt-*' naming coincidence outside this repo's own convention — AC-2 in the body ('non-worktree paths unaffected') already guards this, keep it as a literal regression test, not just a stated intent."
reasoning: "P2 via formula (impact 0.40 < 0.7/0.8 thresholds). technical_risk banded at 0.15 (0.0-0.2 band: known repo pattern, 2 files, trivially git-revertible, string-only heuristic, no new deps). autonomous_safe true: all three risk/effort/dependency thresholds well under 0.6, and the body's proposed ACs are already Given-When-Then shaped with concrete example paths."
triage_notes: "Follow-up to the FEAT-423 architect-reviewer fix (CONCERNS-blocking): deriveProject's cwd-basename fallback is known to collide across git worktrees. Deliberately left out of scope for the bounded correctness fix so it doesn't expand that slice."
---

# FEAT-425: worktree-safe project identity for cwd-derived project/repo

## Requester

Internal follow-up surfaced during the `/crew:fix` on FEAT-423's write-side
project-derivation change (architect-reviewer CONCERNS-blocking fix,
`src/pipeline/derive-project.ts`).

## Problem — cwd basename fragments recall across worktrees

`deriveProject(cwd, repo)` and `deriveRepoFromCwd(cwd)`
(`src/tag-hygiene/derive-repo.ts`) both fall back to `basename(cwd)` when no
explicit `repo`/`project` is available. For a session running inside a git
worktree — e.g. `C:\work\mega\astramemory-local-worktrees\wt-423b` — the
basename is `wt-423b`, not `astramemory-local`. Since recall's `project`
filter is exact-match (`src/search/search.ts`), memories captured from
different worktrees of the same repo land under different `project` values
and don't recall together, even though they're conceptually the same
project.

The FEAT-423 fix flipped `deriveProject`'s precedence so an explicit `repo`
wins over the cwd basename (mitigating the common case where `repo` is
populated), but the cwd-basename fallback itself is still worktree-unsafe
for sessions/backfill runs where no `repo` signal exists at all.

## Requested capability

Make the cwd-basename fallback (used by both `deriveProject` and
`deriveRepoFromCwd`) worktree-aware, using string heuristics only (no `git`
subprocess or filesystem `stat` from the daemon — it may run on a different
machine/time than the client cwd):

1. Detect a `-worktrees/wt-*`-shaped (or similarly-conventioned) path segment
   and strip it, resolving to the parent repo directory name instead.
2. Keep the heuristic conservative — only strip a recognized worktree
   convention; do not attempt canonical repo-name resolution beyond
   string manipulation.
3. Add regression tests proving worktree paths under the recognized
   convention(s) resolve to the base repo name, and that non-worktree paths
   are unaffected.

## Acceptance criteria (proposed — re-triage as you see fit)

- Given a cwd like `.../my-repo-worktrees/wt-foo`, When derived via the
  cwd-basename fallback, Then the result is `my-repo`, not `wt-foo`.
- Given a cwd with no worktree-shaped segment, When derived, Then behavior is
  unchanged from today.
- Given the daemon has no filesystem/git access to the client's actual
  working tree, Then the heuristic remains string-only (no `stat`/`git`
  subprocess calls added).

## Refs

- Depends on: FEAT-423 (`src/pipeline/derive-project.ts`,
  `src/tag-hygiene/derive-repo.ts`).
- Surfaces: `astramem-local` daemon only (write-side derivation + tag-hygiene
  backfill).
