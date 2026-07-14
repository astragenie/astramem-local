# Task Handoff: release/v0.18.0-codex-default: PR #293 opened

- Created: 2026-07-14T12:34:18.697Z
- From: release-engineer
- To: dispatcher
- Objective: Default LLM provider (compaction+extraction) flipped from ollama/qwen3.5:4b to codex-subscription/gpt-5.4-mini in a fresh worktree; build/typecheck/341 tests green; PR #293 opened against main, not tagged/published/merged.
- Allowed Scope:
  - New branch release/v0.18.0-codex-default off origin/main in a fresh worktree (C:/work/mega/astramemory-local-worktrees/release-v0180-codex-default). Config default flip + init wizard default flip + version bump + tests + CHANGELOG.
- Forbidden Scope: -
- Deliverable: PR https://github.com/astragenie/astramem-local/pull/293 (state OPEN, mergeable MERGEABLE). Commit 3c291ce. package.json 0.17.1 -> 0.18.0. No tag pushed, no npm publish, no merge.
- Changed Files:
  - src/config/config.ts
  - src/cli/init.ts
  - package.json
  - CHANGELOG.md
  - tests/config/config.test.ts
  - tests/config/writer.test.ts
  - tests/cli/init.test.ts
- Confidence: high
- Risks: CI checks (auto-merge, cross-repo-roundtrip, TypeScript type-check, Test self-hosted Bun 1.3, audit) were queued at PR-creation time, not polled to completion — verify green before merge. No live smoke test of an actual codex login + init run; only unit/config-level coverage. Interactive-mode default fallback (codex-subscription only pre-highlighted when a Codex CLI login is already detected on the machine running init, else falls back to ollama) is a judgment call not explicitly specified in the dispatch — flagged in the PR body for reviewer confirmation.
- Suggested Next Handoff: Poll gh pr checks 293; once green, human review + merge decision. Post-merge: manual smoke test of codex login + node dist/cli/index.js init (TTY and non-TTY). Tag + npm publish remain separate, explicitly-approved steps per repo's standing publish authorization (do not auto-tag from this handoff).

