---
id: FEAT-425
status: pending
priority: null
category: platform
target_release: null
created: 2026-07-05
depends_on: [FEAT-423]
slices: []
derived_from: null
tags: [concern:recall, concern:provenance, surface:daemon]
autonomous_safe: null
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
