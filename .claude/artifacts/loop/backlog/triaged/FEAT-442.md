---
id: FEAT-442
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-08
updated: 2026-07-08
depends_on: []
slices: []
derived_from: null
tags: [stack:typescript, surface:schema, concern:governance]
needs_contract: true
needs_ux: false
pm_customer_impact: 0.4
pm_effort_estimate: 0.35
pm_strategic_alignment: 0.75
pm_technical_risk: 0.5
pm_dependency_depth: 0.15
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-08
autonomous_safe: false
triage_notes: "P2 via formula: impact 0.40 < 0.70 and alignment 0.75 < 0.80, so neither P1 branch fires; effort 0.35 < 0.70 so P3 doesn't fire either. technical_risk banded at 0.50 (top of the 0.3-0.5 'new pattern / one module, no contract change, clean rollback' band) — single-module extension of consolidate.ts + memory-events.ts, no new external dependency, no schema migration required to ship (default off), but scored at the band's ceiling rather than its middle because the FEAT's own audit/reversal claim has a confirmed gap (no un-supersede primitive exists) that is real scope, not because of any schema change. composite_score=0.5875. pm_effort_points=3 (band [0.25,0.4)) — well under the FEAT-168 decomposition threshold of 8, no proposed_slices needed. autonomous_safe=false because no AC/spec exists yet (P2, no --deep/--spec flag) — not a risk-threshold override; all three mechanical thresholds (risk 0.50, effort 0.35, dependency 0.15) individually pass."
---
## Description

Autonomous consolidation: auto-accept merge-as-supersede proposals at or above a configurable confidence threshold (config knob, default OFF - current propose/accept human-gate behavior unchanged), keep the human gate below the threshold, every auto-accept event-sourced through memory_events with provenance so it is auditable and reversible. Extends src/consolidate/consolidate.ts's existing two-threshold design (mergeThreshold auto / proposeThreshold gate) with a third band. Evidence: 2026-07-08 ecosystem research D4 month-3 differentiation; competitors do opaque auto-merge (Supermemory isLatest flip), ours stays receipted.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.