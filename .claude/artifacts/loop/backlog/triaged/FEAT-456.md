---
id: FEAT-456
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local, memory]
pm_customer_impact: 0.45
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.6
pm_technical_risk: 0.6
pm_dependency_depth: 0.3
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-09
autonomous_safe: false
triage_notes: "technical_risk 0.6 sits at the entry of the 0.6-0.8 band (cross-module pairing+judge+write-path reach, plus cross-service mirroring; no schema change since it reuses the existing supersede event type, and the design is reversible-by-construction via restore, which keeps it at the low end of the band rather than higher). Reinforces FEAT-451/453 but is itself effort-heavy and touches the same entity-lifecycle surface those slices touch -- P2, autonomous_safe false given the state-mutation cascade risk and decomposition requirement; recommend sequencing after FEAT-453 per the FEAT's own note."
proposed_slices:
  - id_suffix: -SLICE-1
    title: "Contract: auto_contradiction supersede-reason discriminator"
    points: 2
  - id_suffix: -SLICE-2
    title: "Local: pairing + judge + auto-supersede + guard rails"
    points: 5
  - id_suffix: -SLICE-3
    title: "Cloud: mirror contradiction-detection stage + event parity"
    points: 3
---
## Description

**Contradiction detection → automatic supersede.**

Today `supersede` and `invalidate` are manual, and consolidation surfaces *proposals*
(ADR-004) a human/agent must resolve. Add **automatic contradiction detection**: when
a newly-distilled atom conflicts with an existing high-confidence atom, detect it and
auto-supersede the stale one (writing a proper `memory_events` supersede record so it
stays explainable and reversible).

**Why:** mem0 and Zep detect when new info contradicts stored info and auto-resolve.
Without this, memory silently accumulates contradictions and recall returns stale
facts alongside their corrections. Directly reinforces FEAT-451 (profile stays
consistent) and FEAT-453 (fact-level validity).

### Detection approach (shared design)
- Candidate pairing: embedding-similarity neighbors of the new atom within the same
  entity/scope (cheap recall of possible conflicts).
- Conflict judgment: a local LLM judge classifies each pair as
  {agrees, refines, contradicts, unrelated}. Only `contradicts` triggers action.
- Action: auto-supersede the older atom (or the lower-confidence one) via the normal
  event path; NEVER hard-delete. Guard rails: confidence threshold, per-run cap, and
  an audit trail so a bad auto-supersede is one `restore` away.

### Local scope (astramem-local, TS)
- New post-distill stage that runs the pair→judge→supersede flow; reuse fuse neighbor
  search + the distill LLM provider for the judge.
- Config: `consolidation.autoSupersede { enabled, minConfidence, maxPerRun }`
  (mirrors the existing `autoAcceptThreshold` FEAT-442 pattern), default OFF.
- Determinism: judge stubbed under the fake embedder so the eval gate stays green.

### Cloud scope (memory, .NET 10)
- Same detection stage server-side for SaaS-ingested content that didn't pass through
  a local daemon; honor the same thresholds; emit the same supersede event type so
  history is uniform across products.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Reuse the existing supersede event type; add an optional `reason: 'auto_contradiction'`
  discriminator + confidence on the event so provenance shows it was automatic.
  Additive → `contracts-v2.x`.

### Approximate ETA (1 dev)
- Contract event discriminator: ~0.5d
- Local: pairing + judge + auto-supersede + guard rails + eval determinism: **~4–5d**
- Cloud: mirror stage + event parity: **~3–4d**
- **Total ≈ 2 weeks.** Sequence AFTER FEAT-453 if doing both — shared entity-lifecycle
  surface. Ship with default OFF and a dry-run/report mode before enabling auto-action.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #6). Applies to BOTH products. Reversible
by construction (event-sourced supersede). Unscored; run `/runner:triage`.

## Proposed slices (PM decomposition)

- SLICE-1: Contract: auto_contradiction supersede-reason discriminator (2 pts)
- SLICE-2: Local: pairing + judge + auto-supersede + guard rails (5 pts)
- SLICE-3: Cloud: mirror contradiction-detection stage + event parity (3 pts)
