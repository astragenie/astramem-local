---
id: FEAT-445
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-08
updated: 2026-07-08
depends_on: []
slices: []
derived_from: null
tags: [stack:typescript, surface:docs, concern:none]
needs_contract: false
needs_ux: false
pm_customer_impact: 0.25
pm_effort_estimate: 0.15
pm_strategic_alignment: 0.4
pm_technical_risk: 0.3
pm_dependency_depth: 0.1
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-08
autonomous_safe: false
triage_notes: "P2 via formula: impact 0.25 and alignment 0.40 are both far below the P1 thresholds; effort 0.15 is far below the P3 threshold (effort>=0.7) despite low impact, so this lands P2 by the formula's default branch even though it is arguably the lowest-value item in the batch by design (cheap+low-value doesn't map to P3 in this formula, which reserves P3 for expensive+low-value items — noting this as a formula characteristic, not overriding it). composite_score=0.4925. technical_risk banded at 0.30: the SUBJECT MATTER (native-module compilation) is genuinely uncertain, but the FEAT itself is the properly-scoped de-risking mechanism for that uncertainty (a timeboxed, no-commitment investigation with a discardable prototype) — scoring the spike's own risk, not the hypothetical future shipped feature's risk, per the rubric's guidance to band the actual FEAT in front of me. pm_effort_points=2 (band [0.1,0.25)), well under the decomposition threshold. autonomous_safe=false because no AC/spec exists yet (P2, no --deep/--spec flag); all three mechanical thresholds pass individually. Note for a future slicing pass: even at P2, this spike would benefit from 2-3 lightweight ACs of its own (explicit stop condition tied to the 1-day timebox, and a forced ship/defer/never conclusion) since 'no AC' is exactly what makes an open-ended spike risky to hand to an autonomous builder."
---
## Description

Single-binary distribution spike (timeboxed 1 day): evaluate bun build --compile for astramem-local — key risks are native modules (better-sqlite3-multiple-ciphers, @napi-rs/keyring) and the migrations/dist file layout. Deliverable is a feasibility REPORT + working prototype if trivial, not a shipped artifact: what works, what breaks, binary size, startup time, recommendation (ship/defer/never). Counters Supermemory's 'one binary zero config' packaging claim (2026-07-08 supermemory matrix, packaging gap #3).

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.