---
findings: "healthy:341,degraded:0,down:0"
---
# Deployment Check: release/v0.18.0-codex-default: PR opened, verified green

- Created: 2026-07-14T12:34:06.284Z
- Deployer: release-engineer
- Environment: dev (worktree branch, PR not yet merged)
- Resource: -
- Service URL: -
- Revision: -
- Decision: passed_with_notes
- Action: Default LLM provider switched to codex-subscription/gpt-5.4-mini in a fresh worktree branch; build+typecheck+341 tests green; PR #293 opened against main; not tagged/published/merged.
- Evidence Collected:
  - bun install: 255 packages. bun run build (tsc -p .): clean. bun run typecheck:tests (tsc -p tsconfig.tests.json): clean. bunx vitest run tests/config/config.test.ts tests/cli/init.test.ts: 2 files / 52 tests passed. bunx vitest run tests/config/ tests/cli/: 36 files / 341 tests passed (fixed one additional stale assertion found in tests/config/writer.test.ts during the sweep). Commit 3c291ce on release/v0.18.0-codex-default
  - pushed to origin. PR https://github.com/astragenie/astramem-local/pull/293 created
  - state OPEN
  - mergeable MERGEABLE
  - CI checks queued (auto-merge
  - cross-repo-roundtrip
  - TypeScript type-check
  - Test (self-hosted
  - Bun 1.3)
  - audit).
- Files / Surfaces Checked:
  - src/config/config.ts
  - src/cli/init.ts
  - package.json
  - CHANGELOG.md
  - tests/config/config.test.ts
  - tests/config/writer.test.ts
  - tests/cli/init.test.ts
- Risks: CI checks were still queued/in-flight at PR-creation time and were not polled to completion in this session — re-check gh pr checks 293 before merge. Live behavior (actual codex login + init run) was not smoke-tested, only unit/config-level tests. Production promotion (tag + npm publish) explicitly deferred per instructions and still requires separate approval.
- Required Follow-up: Poll gh pr checks 293 to green before merge/tag. After merge, manual smoke test: codex login + node dist/cli/index.js init (both TTY and non-TTY) confirming config.yaml writes provider: codex-subscription / model: gpt-5.4-mini for compaction+extraction and provider: ollama / model: mxbai-embed-large for embedding. Tag + npm publish are separate, human-initiated steps.

