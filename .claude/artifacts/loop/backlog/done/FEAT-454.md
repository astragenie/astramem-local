---
id: FEAT-454
status: triaged
priority: P3
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local, memory]
pm_customer_impact: 0.3
pm_effort_estimate: 0.32
pm_strategic_alignment: 0.5
pm_technical_risk: 0.3
pm_dependency_depth: 0.15
pm_composite_priority: P3
pm_autonomous_safe: true
pm_reviewed: 2026-07-09
autonomous_safe: true
triage_notes: "technical_risk 0.3 sits at the low end of the 0.3-0.5 band (new pattern -- a mode-routing layer plus an additive contract enum across two codebases -- but no scoring-logic changes and no schema change, per the FEAT's own scope). Cheapest and least differentiated of the six competitor-gap FEATs -- P3, autonomous-safe given the small, additive, well-bounded blast radius."
---
## Description

**Named retrieval presets** — expose our existing retrieval capabilities as a small
set of named presets instead of one implicit fusion pipeline + ad-hoc filters.

**BLOCKER, now fixed by renaming the concept:** the original body proposed a
`mode` field, but `mode` is already a required, live field in the shared contract
with different semantics — enum `["keyword","semantic","hybrid"]`
(contracts/schemas/retrieval-query.v1.schema.json:12-15), live in cloud production
(`SearchQuery.cs:53`, `MemoryQueryService.cs:91-103` drives a real switch + OTel).
Reusing the name `mode` for this FEAT's weight-routing concept would collide with
that existing field. This FEAT uses **`preset`** instead, and is scoped
**local + MCP-only** — it does not touch the cloud `mode` field or its endpoints.

**Why:** Cognee exposes 18 named search modes (`SearchType.py:5-21`, code-verified).
Most are graph-specific (out of scope per kill-list), but a couple map onto things
astramem-local ALREADY does and just doesn't name: temporal/as-of search,
entity-scoped search, and (roadmap) code-aware search. Named presets are a UX +
discoverability win and cost little because the retrieval logic already exists.

Deliberately SMALL: this is a naming/routing surface over existing capabilities, not
new retrieval engines. Confirmed trivial by architecture review: `default`/`recent`/
`exact` are weight-preset routing over the existing fusion weights
(src/search/fuse.ts:107-126); `entity`/`temporal` map to existing filters
(src/search/search.ts:75-85, 190-195).

### Local scope (astramem-local, TS)
- Define a `preset` enum: `default` (current fusion), `temporal` (as-of scoped),
  `entity` (entity-filtered), `recent` (freshness-weighted), `exact` (BM25-first).
  Map each to existing fuse/filter config — no new scoring code.
- Accept `preset` on `/search` + `/recall` and the MCP `search_memory` / `recall_memory`
  tools; document each preset + when to use it.
- Keep `default` byte-identical to today's behavior (no silent ranking change).
- Every preset's weight/filter values must be constructed through the existing
  `applyFusionGovernance` path (src/search/config.ts:334) — never hand-rolled
  literals bypassing governance.
- Decide and document the behavior of `preset=temporal` when no `as_of` is
  supplied: error, or fall back to "now"? Pick one before implementation.

### Cloud scope (memory, .NET 10)
- Out of scope for this FEAT — cloud's `mode` field already means something
  different (keyword/semantic/hybrid routing). If preset-style routing is wanted
  cloud-side later, that is a separate FEAT with its own contract field, not an
  extension of this one.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Add a `preset` enum to the local search/recall request only (not the shared
  cross-product retrieval-query contract, to avoid the `mode` collision). Additive,
  defaulted → non-breaking.

### Acceptance criteria (added — architecture review)
- AC-1: Given `preset=default` (or no preset supplied), When a query runs through
  `/search` or `/recall`, Then the ranking is byte-identical to today's behavior —
  enforced by a snapshot test mirroring the existing zeta=0 pattern at
  `tests/eval/retrieval-eval.test.ts:140-164`.
- AC-2: Given any named preset, When its weights/filters are constructed, Then they
  are built exclusively through `applyFusionGovernance` (src/search/config.ts:334)
  — no preset hand-rolls literal weight values outside that path.
- AC-3: Given `preset=temporal` with no `as_of` supplied, When the query runs, Then
  the documented, deliberately-chosen behavior (error vs. fallback-to-now) is what
  actually happens — not an accidental default.

### Approximate ETA (1 dev)
- Contract enum (local-only): ~0.5d
- Local: routing + docs + tests (no new scoring): **~2–3d**
- **Total ≈ 3–4 days, local + MCP only.** Lowest-effort of the six; good warm-up /
  early win. (Cloud mirroring dropped from scope — see corrections.)

## Intake notes
From 2026-07-09 competitor gap analysis (gap #4). Effort S — mostly exposing existing
capability. Unscored; run `/runner:triage`.

## Architecture review corrections (2026-07-09)

**Blocker, fixed:** the original body's `mode` field collided with an existing
required, live contract field of the same name — enum
`["keyword","semantic","hybrid"]` (contracts/schemas/retrieval-query.v1.schema.json:12-15),
already driving a real switch + OTel in cloud production
(`SearchQuery.cs:53`, `MemoryQueryService.cs:91-103`). Fixed by renaming this
FEAT's concept to **`preset`** and scoping it **local + MCP-only** (cloud scope
removed).

Everything else was confirmed trivial: `default`/`recent`/`exact` are weight-preset
routing over existing fusion weights (src/search/fuse.ts:107-126); `entity`/
`temporal` map to existing filters (src/search/search.ts:75-85, 190-195).

Added as hard ACs: (a) `preset=default` byte-identical ranking snapshot test
(mirrors the AC-6 zeta=0 pattern at tests/eval/retrieval-eval.test.ts:140-164);
(b) presets must be constructed through `applyFusionGovernance`
(src/search/config.ts:334), never hand-rolled literals; (c) `preset=temporal` with
no `as_of` supplied must have a deliberately decided, documented behavior (error vs
fallback), not an accidental default.
