---
id: FEAT-484
status: done
priority: null
category: feature
target_release: null
created: 2026-07-13
updated: 2026-07-13
depends_on: []
slices: []
derived_from: null
---
## Description

Worktree-sourced memories are filed under a garbage repo name — provenance bug (GitHub issue #177). Observed 2026-07-13: memories distilled from subagent sessions running in git worktrees are stamped repo='agent-ac72934b8fdc982ea' (the worktree DIRECTORY name) instead of 'astramemory-local'. Evidence: memory cb739530-4df6-47b4-8e2d-f57610210d00 ('qwen2.5-coder:7b can extract correct entities on naturalistic transcripts but often omits relations unless the input closely matches the few-shot pattern') carries repo=agent-ac72934b8fdc982ea. Impact, compounding: (1) repo-scoped recall (SearchFilters.repo) silently misses every worktree-sourced memory — they are filed under an ephemeral id nobody will ever query; (2) consolidation groups per (repo, type), so worktree memories NEVER dedupe against their main-checkout equivalents and accumulate as permanent near-duplicates; (3) the worktree directory is deleted when the agent finishes, so the repo value points at a path that no longer exists. This gets worse continuously because parallel agent work in isolated worktrees is now the STANDARD pattern in this repo — a growing population of unreachable, un-dedupable memories. Fix: resolve repo identity from the git common-dir / origin remote (git rev-parse --git-common-dir, or the remote URL) rather than the working-directory basename, so a worktree resolves to the same repo identity as its main checkout; find where the capture envelope's repo field is derived (hook side and/or src/distill provenance). Plus a one-shot backfill/migration to re-stamp memories already stored under agent-* repo names (many already exist on this box). Acceptance should include a canary: ingest from a worktree, assert the resulting memory carries the project repo name, not the worktree basename.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
> **Closed 2026-07-17.** repo-identity fix + backfill merged #405 (91baa1be); ingest hot-path made async in review-fix (3c7d5d02)
