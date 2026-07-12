---
id: FEAT-475
status: triaged
priority: P2
category: bug
target_release: null
created: 2026-07-12
updated: 2026-07-12
depends_on: []
slices: []
derived_from: 2026-07-12 wave reviews — two agents independently hit it
cross_product: [astramem-local]
autonomous_safe: true
tags: ["concern:testing", "stack:typescript", "surface:ci", "followup:FEAT-471"]
pm_customer_impact: 0.45
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.6
pm_technical_risk: 0.35
pm_dependency_depth: 0.1
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-12
triage_notes: "P2 via formula: impact 0.45 < 0.70 and alignment 0.60 < 0.80, so neither P1 branch fires; effort 0.55 < 0.70 so P3 doesn't fire either (and impact 0.45 > 0.30 so P3's second condition also fails) — lands P2 by the formula's default branch, same tier as its sibling FEAT-471. composite_score=0.1575+0.18+0.09+0.065+0.045=0.5375 (~0.54), higher than FEAT-471's 0.51 due to the frequency/recurrence bump in customer_impact and strategic_alignment. technical_risk banded at 0.35 (0.3-0.5 band: 'new pattern in repo OR one module, no contract change, clean rollback') — test-isolation fix only, no schema/runtime change, clean per-file revert; scored above FEAT-471's 0.25 to reflect the wider, not-yet-confirmed-single-root-cause footprint (4+ files across up to 3 subsystems) without crossing into the 0.6-0.8 'cross-module reach' band, since the actual blast radius is confined to test infrastructure, not production code paths. pm_effort_points=5 (band [0.4,0.6)) — under the FEAT-168 gate threshold (8), no proposed_slices required. autonomous_safe=true: all three mechanical thresholds (risk 0.35, effort 0.55, dependency 0.10) pass individually, AND — unlike a typical P2 with no drafted AC — this FEAT carries its own explicit, quantified acceptance bar in its Scope section ('5 consecutive full-suite runs green under an artificial parallel load'), which is the same substitute-for-AC reasoning FEAT-471 used to justify autonomous_safe=true at P2; that bar is testable by a builder unattended."
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
