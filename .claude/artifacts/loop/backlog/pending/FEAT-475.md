---
id: FEAT-475
status: pending
priority: null
category: bug
target_release: null
created: 2026-07-12
updated: 2026-07-12
depends_on: []
slices: []
derived_from: 2026-07-12 wave reviews — two agents independently hit it
cross_product: [astramem-local]
autonomous_safe: null
tags: ["concern:testing", "stack:typescript", "surface:ci", "followup:FEAT-471"]
---
## Description

**Eval detach/daemon-manifest tests flake under parallel load** — sibling of
FEAT-471 (fixed, merged) but in a different file family: during 2026-07-12
wave reviews, two independent reviewer agents running the full suite under
box load hit failures in `scripts/eval/longmemeval/detach-kill-resume.test.ts`
and `scripts/eval/shared/daemon-manifest.test.ts` (e.g. the spawnDetached
heartbeat-timing assertion, and "pid whose port is not listening →
already-dead"). All pass in isolation; failures only appear with concurrent
suite runs / builder agents active.

### Scope

- Same treatment as FEAT-471: root-cause the shared resource or timing margin
  (these tests do real process spawn/kill + port probing — likely
  idle-box-tuned heartbeat/probe timeouts), then isolate or widen budgets with
  measured rationale. No retry/skip.
- Evidence bar: 5 consecutive full-suite runs green under an artificial
  parallel load, matching FEAT-471's bar.
- FEAT-471's fix (tests/scripts/post-merge-rebuild.test.ts +
  tests/service/release.test.ts) is merged and holding — do not re-touch
  those files.

### Update 2026-07-12 (later)

Third reviewer full-suite run flaked a DIFFERENT pair: tests/backup/
snapshot.test.ts + tests/cli/capture-claude.test.ts. Flake is spread across
4+ files under load, not just the eval detach family — widen root-cause scope
accordingly.
