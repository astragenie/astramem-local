---
id: FEAT-429
status: triaged
priority: needs-review
category: platform
target_release: null
created: 2026-07-05
updated: 2026-07-07
depends_on: []
slices: []
derived_from: arch-review-FEAT-426-2026-07-05
tags: [concern:maintainability, surface:search, surface:api, surface:cli]
pm_customer_impact: 0.30
pm_effort_estimate: 0.65
pm_strategic_alignment: 0.45
pm_technical_risk: 0.50
pm_dependency_depth: 0.10
pm_effort_points: 8
composite_score: 0.41
composite_priority: needs-review
autonomous_safe: false
pm_demand_evidence: "Internal engineering-pain evidence (not end-user facing): triage_notes quotes 'at least the 4th repetition of the identical pattern' and the FEAT body names the exact ~8-file lockstep edit. Cross-referenced against source: src/search/fuse.ts (222 lines) and src/search/search.ts (513 lines) confirm these are real, actively-edited files."
pm_scope_notes: "pm_effort_estimate 0.65 maps to pm_effort_points 8 — trips the FEAT-168 decomposition gate. Cannot be decomposed responsibly right now: the FEAT's own body asks the open design question first ('Evaluate whether a descriptor table + generated bindings is worth the indirection'). Slicing before that choice risks sizing slices around the wrong design. Recommend runner:architect produce a short design note (registry+codegen vs. enforced-checklist test) before this returns to PM for effort re-scoring and slicing."
pm_risks:
  - "Forcing a registry/codegen abstraction onto 7 already-working filters purely to satisfy 'no more repetition' risks the classic over-engineering trap (Core Rule 2, scope discipline) — the FEAT itself hedges with 'evaluate whether... is worth the indirection'; a lighter enforcement test (single test that fails when a filter is added to fuse.ts without a matching CLI/MCP/route entry) may be the right answer."
  - "If a registry IS built, 'byte-identical behavior' for existing filters is a strong claim needing regression coverage across CLI, MCP schema, route parsing, and dashboard debug string simultaneously — a partial migration that silently changes wire behavior for one surface is the failure mode most likely to slip past a narrow unit-test pass."
reasoning: "Formula would return P2, but FEAT-168's decomposition gate is mandatory once pm_effort_points>=8 and overrides to composite_priority: needs-review (the FEAT resists decomposition: the architectural approach itself is undecided). technical_risk banded at 0.50 (new pattern in repo, cross-module reach across ~8 files, no schema/data change, clean git-revert rollback if done incrementally)."
triage_notes: "Arch-review of FEAT-426 finding 4. Every new search filter/signal (repo, project, agent, entity, since, as_of, and now agentMode) requires the same shotgun edit across ~8 files: fuse.ts -> search.ts -> routes/search.ts -> cli/search.ts -> cli/index.ts -> mcp/server.ts -> config -> dashboard-search-html. This is at least the 4th repetition of the identical pattern — a decent signal that a single-source filter-descriptor registry would pay for itself."
---

# FEAT-429: filter-descriptor registry — collapse the N-file-per-signal shotgun edit

## Problem
Adding one search filter/signal today means editing the same ~8 production files
in lockstep (fuse weight, SearchFilters field, SQL clause, route query/body
parse, CLI flag, MCP tool schema, config weight, dashboard debug string). Missing
any one silently degrades a surface (the exact class of drift FEAT-424 documents
for `agent`). FEAT-426's `agentMode` was the 4th+ repetition of this pattern.

## Requested capability
A single source of truth mapping each filter/signal → its (a) SQL clause / fusion
weight, (b) wire field name + type, (c) CLI flag, (d) MCP schema entry, (e) route
binding, so a new signal is a one-place addition and every surface derives from
it. Evaluate whether a descriptor table + generated bindings is worth the
indirection vs the current explicit-but-repetitive wiring.

## Acceptance (proposed — re-triage)
- A filter/signal registry exists; adding a new filter touches one definition (or
  the registry enumerates every surface a change must update, enforced by a test).
- Existing filters (repo/project/agent/agentMode/entity/since/as_of) migrated or
  demonstrably expressible in it with byte-identical behavior.

## Refs
- Arch review: `.claude/artifacts/crew/reviews/20260705T*-review-result-feat-426-*` (finding 4).
- Related drift ticket: FEAT-424 (cross-surface contract unification).
