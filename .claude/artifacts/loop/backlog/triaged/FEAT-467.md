---
id: FEAT-467
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
blocks: [FEAT-458]
slices: []
derived_from: docs/adr/ADR-013-llm-proxy-auto-capture.md (Review decision 4, 2026-07-10)
cross_product: [astramem-local]
tags: ["concern:security", "concern:lifecycle", "stack:typescript", "surface:daemon"]
pm_customer_impact: 0.45
pm_effort_estimate: 0.5
pm_strategic_alignment: 0.72
pm_technical_risk: 0.5
pm_dependency_depth: 0.25
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-10
autonomous_safe: false
triage_notes: "P2 via formula (default branch): impact 0.45 < 0.70 so the (impact>=0.7 AND alignment>=0.6) P1 branch does not fire; alignment 0.72 < 0.80 so the (alignment>=0.8 AND effort<=0.4) P1 branch does not fire either (effort 0.5 also fails that branch's <=0.4 half independently); effort 0.5 < 0.70 so P3 does not fire. composite_score = 0.45*0.35 + 0.72*0.30 + (1-0.5)*0.20 + (1-0.5)*0.10 + (1-0.25)*0.05 = 0.561 — the highest composite of this 4-FEAT batch despite landing P2, because strategic_alignment is scored high (0.72): this is a formal, ADR-013-accepted hard blocker on FEAT-458 (LLM proxy auto-capture), with the operator security review explicitly rejecting re-acceptance of the weaker FEAT-455 posture for the higher-volume proxy tier. Direct customer_impact of THIS primitive alone is scored moderate (0.45), not high, because it is an internal lifecycle/audit mechanism, not a user-facing feature by itself — its value is almost entirely in unblocking FEAT-458. technical_risk banded at 0.5: touches invalidate() semantics used elsewhere in the lifecycle, needs a real reversal primitive (tombstone/soft-delete + restore, or exportable snapshot) plus durable audit records — moderate complexity, no schema-breaking change expected, but the FEAT's own text defers the reversal-mechanism design choice to FEAT-458 slice 1, meaning this ticket is not yet fully self-contained. dependency_depth scored 0.25: depends_on is empty, but the design-deferral to FEAT-458 slice 1 is a real (if soft) coupling not captured by depends_on alone. autonomous_safe=false: forced by the missing-AC gate — this triage pass drafts ACs only for FEAT-465/466 per the coordinator's scope, not for FEAT-467 — reinforced by the FEAT's own admission that the reversal-primitive design is intentionally left open pending FEAT-458 slice 1, making an unattended autonomous build premature regardless of the mechanical thresholds (risk 0.5, effort 0.5, dependency 0.25) all individually passing. Recommend scheduling this immediately before or alongside FEAT-458 slice 1 given the gate linkage, even though its formula priority lands P2."
---
## Description

**invalidate() reversal/audit gap — hard prerequisite for proxy auto-capture
(FEAT-458)** — the FEAT-455 spike (checklist #5) identified that the purge path
behind "disable auto-capture → retroactively remove captured content" rides on
`invalidate()` with no reversal primitive and incomplete audit: a purge cannot
be undone, and what exactly was purged is not fully reconstructable afterward.
Hook-tap (FEAT-455) shipped with this risk re-accepted. ADR-013's 2026-07-10
operator security review **rejected re-accepting it** for the proxy tier:
proxy capture volume makes a weak disable→purge promise a trust breach.

### Scope

- Reversal primitive: purge performed by the auto-capture disable flow must be
  reversible for a bounded window (tombstone/soft-delete generation with
  restore, or an exportable pre-purge snapshot) — design to be settled in
  FEAT-458 slice 1 (design gate) per ADR-013.
- Audit completeness: a purge writes a durable record of what was removed
  (ids, capture_source, time range, count) sufficient to verify the promise
  "turning it off removed what it captured."
- Applies to both `capture_source: 'auto_capture'` (hook-tap, retrofits the
  455 acceptance) and the future `'proxy'` value.

### Gate linkage

FEAT-458's capture fork MUST NOT ship before this FEAT is done (ADR-013
Review decisions, item 4). Belongs inside or immediately before FEAT-458
slice 1.
