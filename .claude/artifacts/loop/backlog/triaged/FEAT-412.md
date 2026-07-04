---
id: FEAT-412
status: triaged
priority: P0
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: arch-review-2026-07-04
pm_customer_impact: 0.70
pm_effort_estimate: 0.25
pm_strategic_alignment: 0.85
pm_technical_risk: 0.25
pm_dependency_depth: 0.20
pm_effort_points: 2
composite_score: 0.77
composite_priority: P0
autonomous_safe: true
pm_demand_evidence: "Incident already fired this session: concurrent wave-loop branch ops reverted mock-providers.ts + package.json in the shared main tree, recovered only via a stash commit; architecture review ranked this debt #1."
pm_scope_notes: "Smallest deliverable: change worktree provisioning in loop/dispatch config to `git worktree add ../<name>` (sibling dir), update docs. Existing vitest **/.claude/** exclusion stays as belt-and-suspenders."
pm_risks:
  - "Any script/tool hardcoding .claude/worktrees/<name> paths (cost attribution, artifact links) needs auditing for the new location."
reasoning: "Cheapest, safest, highest-leverage item in the batch: mechanical path change, zero production code touched, prevents a failure class (silent overwrite of uncommitted work) that already cost real recovery effort once."
---
# FEAT-412: Move agent/wave worktrees out of the tracked repo root

## Problem
.claude/worktrees/<name>/ nests full repo copies INSIDE the tracked working tree. Consequences observed 2026-07-04: (a) vitest double-discovered nested test suites → spawned-daemon port collisions (patched via vitest.config.ts **/.claude/** exclusion — symptom fix); (b) concurrent wave-loop branch ops reverted files in the shared main tree (mock-providers.ts, package.json) — recovered only via a lucky stash commit. Architecture review: exclusion lists are "a permission list on a hazard that persists physically"; ranked #1 in debt (already fired once).

## Acceptance (PM GWT)
1. Given the loop dispatcher provisions a new agent/wave worktree, When it creates the workspace, Then it uses a sibling directory (git worktree add ../name) outside the tracked repo root, not .claude/worktrees/name.
2. Given a repo-walking tool (vitest, tsc, lint, watchers) runs at repo root, When it discovers files, Then no .claude/worktrees exclusion is required for correctness (existing exclusion may remain, nothing new depends on it).
3. Given interactive /crew:build and the wave loop are both active, When both perform git operations concurrently, Then they operate on physically separate worktrees and cannot revert each other's uncommitted files in the shared main tree.
4. Given the loop/deployment docs, When an operator reads them, Then they explicitly state interactive builds and the wave loop must never share a checkout.
5. Given crew:parallel spawns N workers, When they complete or fail, Then all N sibling worktrees are created and cleaned up correctly.

## Evidence
Run artifact 2026-07-04 incident log + architecture review finding 4 [MED-HIGH], debt rank 1.
