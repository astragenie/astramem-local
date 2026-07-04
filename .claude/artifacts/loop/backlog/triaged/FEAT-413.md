---
id: FEAT-413
status: triaged
priority: P2
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: arch-review-2026-07-04
pm_customer_impact: 0.40
pm_effort_estimate: 0.20
pm_strategic_alignment: 0.40
pm_technical_risk: 0.20
pm_dependency_depth: 0.15
pm_effort_points: 2
composite_score: 0.59
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "Architecture review finding 2 [MEDIUM] — no response-side validation; recommend before next search-path change. Root cause already fixed and regression-tested in cedc8a9 — this is incremental defense-in-depth, not a live bug."
pm_scope_notes: "Smallest deliverable: one clamp+log at the route/serializer boundary, independent of fuseScores. Do not expand into a general response-validation framework."
pm_risks:
  - "Low — cheap, isolated change; main risk is scope creep into a bigger validation layer than the AC asks for."
reasoning: "Genuinely useful cheap insurance, but the bug it guards against is already fixed twice with regression tests. Worth doing, not urgent — the live wire-contract risk is better addressed by FEAT-411's CI gap."
---
# FEAT-413: Response-side score contract enforcement at daemon serialization boundary

## Problem
The [0,1] score wire contract is enforced only by fuseScores() internal math and the PLUGIN's client-side Zod. The daemon has no response-side validation: any future path constructing a hit score outside fuseScores (second fusion strategy, manual override, cache serving stale raw values) ships invalid wire data silently — client rejects after the fact with no server-side signal (exactly how the cedc8a9 bug surfaced: plugin exit 3, daemon oblivious).

## Acceptance
- Cheap clamp/assert where search/recall hits serialize to JSON (route handler or shared response serializer), independent of fuseScores.
- Out-of-range value logs a server-side warning (observable), clamps rather than 500s.
- Test: hand-crafted out-of-contract score at the serializer → clamped + logged.

## Evidence
Architecture review finding 2 [MEDIUM] — "recommend before next search-path change".
