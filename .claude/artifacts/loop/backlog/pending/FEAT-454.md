---
id: FEAT-454
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local, memory]
---
## Description

**Named retrieval modes** — expose our existing retrieval capabilities as a small
set of named modes instead of one implicit fusion pipeline + ad-hoc filters.

**Why:** Cognee exposes 18 named search modes (`SearchType.py:5-21`, code-verified).
Most are graph-specific (out of scope per kill-list), but a couple map onto things
astramem-local ALREADY does and just doesn't name: temporal/as-of search,
entity-scoped search, and (roadmap) code-aware search. Named modes are a UX +
discoverability win and cost little because the retrieval logic already exists.

Deliberately SMALL: this is a naming/routing surface over existing capabilities, not
new retrieval engines.

### Local scope (astramem-local, TS)
- Define a `mode` enum: `default` (current fusion), `temporal` (as-of scoped),
  `entity` (entity-filtered), `recent` (freshness-weighted), `exact` (BM25-first).
  Map each to existing fuse/filter config — no new scoring code.
- Accept `mode` on `/search` + `/recall` and the MCP `search_memory` / `recall_memory`
  tools; document each mode + when to use it.
- Keep `default` byte-identical to today's behavior (no silent ranking change).

### Cloud scope (memory, .NET 10)
- Accept + honor the same `mode` enum on its retrieval endpoints; identical semantics
  so a query behaves the same local vs cloud.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Add a `mode` enum to the search/recall request. Additive, defaulted → non-breaking
  (`contracts-v2.x`). Single source of the enum so local + cloud can't drift.

### Approximate ETA (1 dev)
- Contract enum: ~0.5d
- Local: routing + docs + tests (no new scoring): **~2–3d**
- Cloud: mirror routing: **~2d**
- **Total ≈ 1 week.** Lowest-effort of the five; good warm-up / early win.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #4). Effort S — mostly exposing existing
capability. Unscored; run `/runner:triage`.
