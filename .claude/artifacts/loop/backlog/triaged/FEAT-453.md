---
id: FEAT-453
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
pm_customer_impact: 0.4
pm_effort_estimate: 0.65
pm_strategic_alignment: 0.55
pm_technical_risk: 0.75
pm_dependency_depth: 0.3
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-09
autonomous_safe: false
triage_notes: "technical_risk 0.75 sits in the 0.6-0.8 band (schema/data-shape change via migration 022 plus a mirrored EF Core migration on the cloud side -- rollback needs migration cleanup on both systems, not a plain revert, keeping it below the 0.9+ contract-break band since the change is additive/nullable). Narrower and more contingent than FEAT-451/452 (report's own #3 ranking, gated on further entity-layer investment) -- P2, autonomous_safe false given the schema-change band and decomposition requirement."
proposed_slices:
  - id_suffix: -SLICE-1
    title: "Contract + migration 022 design: fact-level valid_at/invalid_at"
    points: 3
  - id_suffix: -SLICE-2
    title: "Local: distill validity hints + as-of query + lifecycle wiring"
    points: 5
  - id_suffix: -SLICE-3
    title: "Cloud: EF Core migration mirror + query + shipper"
    points: 5
---
## Description

**Entity/fact-level bitemporal tracking** — temporal validity on individual facts,
not just whole memories.

Today `as_of` bitemporal filtering is keyed on the memory envelope's `captured_at`
(memory-level). Add **fact-level** temporal fields on the atom@2 entity layer so a
single memory can carry facts with different validity windows — "X was true
Jan–Mar, superseded Apr" — resolvable at query time.

**Why:** Graphiti tracks `valid_at` / `invalid_at` / `expired_at` per graph edge
(`edges.py:271-282`, code-verified) — finer-grained than our memory-level stamp.
This is the natural next lifecycle primitive now that atom@2 ships typed entities.
NOTE: this is the *narrow* ask (temporal fields on the existing entity layer), NOT
a full graph engine — full graph memory stays on the kill-list.

### Local scope (astramem-local, TS)
- Migration (022): add nullable `valid_at` / `invalid_at` (bitemporal, distinct
  from row `captured_at`) to the entities/atoms table.
- Distill: extract validity hints where the source states them; default to
  captured_at when absent.
- Query: extend as-of resolution to filter at the fact level; fold into fusion.
- Lifecycle: supersede/invalidate set `invalid_at` on the superseded fact rather
  than only writing an event.

### Cloud scope (memory, .NET 10)
- EF Core migration mirroring the fact-level columns; as-of query support in the
  retrieval path; shipper carries the new fields end-to-end.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Add optional `valid_at` / `invalid_at` to the entity/atom shape in the sync
  create-event payload and retrieval result. Additive → `contracts-v2.x`. Guard the
  atom-kind parity gate.

### Approximate ETA (1 dev)
- Contract + migration design: ~1d
- Local: migration + distill hints + as-of query + lifecycle wiring: **~4–5d**
- Cloud: EF migration + query + shipper: **~3–4d**
- **Total ≈ 2–2.5 weeks.** Pairs well with FEAT-456 (contradiction) — both touch the
  entity lifecycle; consider sequencing them back-to-back to amortize the migration.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #3). Contingent on continued entity-layer
investment. Unscored; run `/runner:triage`.

## Proposed slices (PM decomposition)

- SLICE-1: Contract + migration 022 design: fact-level valid_at/invalid_at (3 pts)
- SLICE-2: Local: distill validity hints + as-of query + lifecycle wiring (5 pts)
- SLICE-3: Cloud: EF Core migration mirror + query + shipper (5 pts)
