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

**Fact-level bitemporal tracking** — temporal validity on individual facts within
a memory, layered on top of the memory-level bitemporal support that already ships.

**Memory-level bitemporal already exists.** `memories` has `valid_from`/`valid_to`
(migrations/006-atom-v3.sql:20-21), `as_of` already resolves via
`validityFilterClause` (src/search/search.ts:190-196), and the window is already
part of the atom@2 wire (contracts/schemas/atom.v2.schema.json:83-92). The prior
claim that "`as_of` keys on `captured_at`" was wrong — it keys on `valid_from`/
`valid_to`, with `captured_at` as an unrelated ingest timestamp. This FEAT is about
going one level finer: a single memory can carry facts with different validity
windows — "X was true Jan–Mar, superseded Apr" — resolvable at query time.

**Why:** Graphiti tracks `valid_at` / `invalid_at` / `expired_at` per graph edge
(`edges.py:271-282`, code-verified) — finer-grained than our existing memory-level
window. This is the natural next lifecycle primitive now that atom@2 ships typed
entities. NOTE: this is the *narrow* ask (temporal fields on the existing entity
layer), NOT a full graph engine — full graph memory stays on the kill-list.

### Local scope (astramem-local, TS)
- **Migration target correction:** there is no "atoms" table, and `entities` is a
  deduplicated GLOBAL registry — one row per canonical entity name across the whole
  corpus (migrations/012-entities.sql:24-28). Validity windows are per
  memory-to-entity association, not per entity, so they cannot live on `entities`.
  The correct migration target is the `memory_entities` junction table, which needs
  a surrogate primary key added before it can carry its own columns.
- Migration (022): add nullable `valid_at` / `invalid_at` (bitemporal, distinct
  from the existing memory-level `valid_from`/`valid_to` and from `captured_at`) to
  `memory_entities`.
- Contract note: `atom@2`'s `entities` array is `additionalProperties: false`
  (contracts/schemas/atom.v2.schema.json:117-136), so new optional keys are NOT
  additive against strict validators the way most of our contract changes are —
  this likely needs an `atom@3` bump or a documented, deliberate schema relaxation.
  Fold that decision into the slice-1 design spike.
- Distill: extract validity hints where the source states them; when absent,
  default to the **memory's own `valid_from`**, not `captured_at` (the memory's
  `valid_from` is itself already the intentional bitemporal anchor; falling back to
  the ingest timestamp would silently disagree with the memory-level window).
- Query: fact-level `as_of` is a **projection/join concern layered on top of** the
  existing memory-level filter, not simply another `AND` clause bolted onto
  `validityFilterClause` — a fact-level result still lives inside a memory-level
  window, so the composition needs an explicit design (does a fact-level window
  narrower than the memory's own window win? what happens when they conflict?).
  Design this in slice 1, not slice 2.
- Lifecycle: supersede/invalidate set `invalid_at` on the superseded fact rather
  than only writing an event.

### Cloud scope (memory, .NET 10)
- EF Core migration mirroring the fact-level columns; as-of query support in the
  retrieval path; shipper carries the new fields end-to-end.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Add optional `valid_at` / `invalid_at` to the entity/atom shape in the sync
  create-event payload and retrieval result. **Not a plain additive change**: the
  `atom@2` `entities` array schema is `additionalProperties: false`
  (contracts/schemas/atom.v2.schema.json:117-136), so new optional keys are
  rejected by strict validators today — this needs either an `atom@3` version bump
  or a deliberate, documented relaxation of that schema, decided in slice 1. Guard
  the atom-kind parity gate either way.

### Approximate ETA (1 dev)
- Contract + migration design: ~1d (this must be a **design spike**, not a
  straightforward contract edit — the additionalProperties:false constraint and
  the memory_entities-junction migration target both need a decision before any
  code is written)
- Local: migration + distill hints + as-of query + lifecycle wiring: **~4–5d**
- Cloud: EF migration + query + shipper: **~3–4d**
- **Total ≈ 2–2.5 weeks.** Both this FEAT and FEAT-456 (contradiction) touch the
  entity lifecycle — that's a soft sequencing constraint (don't parallelize their
  migration slices), not a hard `depends_on`.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #3). Contingent on continued entity-layer
investment. Unscored; run `/runner:triage`.

## Proposed slices (PM decomposition)

- SLICE-1: Design spike — contract (atom@3 or documented relaxation) + migration 022 design targeting `memory_entities` (+ surrogate PK): fact-level valid_at/invalid_at (3 pts)
- SLICE-2: Local: distill validity hints + as-of query + lifecycle wiring (5 pts)
- SLICE-3: Cloud: EF Core migration mirror + query + shipper (5 pts)

## Architecture review corrections (2026-07-09)

Two factual errors in the original FEAT body, now corrected above:

1. **Memory-level bitemporal already exists.** `memories.valid_from`/`valid_to`
   (migrations/006-atom-v3.sql:20-21) already back `as_of` resolution via
   `validityFilterClause` (src/search/search.ts:190-196) and are already part of
   the atom@2 wire (contracts/schemas/atom.v2.schema.json:83-92). The original
   claim that `as_of` keys on `captured_at` was wrong.
2. **No "atoms" table.** `entities` is a deduplicated GLOBAL registry — one row
   per canonical name (migrations/012-entities.sql:24-28) — so per-fact validity
   windows cannot live there. The correct migration target is the
   `memory_entities` junction table, which needs a surrogate PK added first.

Additional findings:
- `atom@2`'s `entities` array is `additionalProperties: false`
  (contracts/schemas/atom.v2.schema.json:117-136), so this change is not simply
  additive against strict validators — expect `atom@3` or a documented relaxation.
- Fact-level `as_of` is a projection/join concern composed with the existing
  memory-level filter, not another `AND` clause — needs explicit composition
  design (narrower-window-wins? conflict handling?).
- Default fallback for an unstated validity hint should be the memory's own
  `valid_from`, not `captured_at`.
- Kept: 3-slice contract-first ordering, now explicit that slice-1 is a design
  spike, not a routine contract edit.
- Sequencing vs FEAT-456: soft constraint only (don't parallelize the migration
  slices), not a hard `depends_on`.
