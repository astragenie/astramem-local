---
id: FEAT-429
status: done
priority: P3
category: platform
target_release: null
created: 2026-07-05
updated: 2026-07-07
depends_on: []
slices: []
derived_from: arch-review-FEAT-426-2026-07-05
tags: [concern:maintainability, surface:search, surface:api, surface:cli]
pm_customer_impact: 0.10
pm_effort_estimate: 0.05
pm_strategic_alignment: 0.20
pm_technical_risk: 0.05
pm_dependency_depth: 0.00
pm_effort_points: 1
composite_score: 0.09
composite_priority: P3
autonomous_safe: true
pm_superseded: true
pm_superseded_note: "RESCORED 2026-07-12 (targeted re-triage): the architectural question this FEAT asked ('is a descriptor table worth the indirection') was already answered and shipped before this doc's last update. src/contracts/filter-registry.ts exists in full (FilterDescriptor type, RECALL_FILTER_REGISTRY, buildFilterFieldsSchema/assignStructuredFilterValues/assignQueryFilterValues/applySqlColumnFilters/applySqlRangeFilters) and src/contracts/recall-filters.ts derives its exported schemas from it. Commits: 85b46f0/c3a81ea (#105, project/agent/entity registry), d50fd1d/46845aa (SLICE-B, repo+since onto the registry), rolled up in c90b875 (#123). A prior design note (.claude/artifacts/loop/plans/20260707T121447Z-design-FEAT-429-filter-registry.md) already flagged this same finding on 2026-07-07 and this doc's frontmatter (composite_priority: needs-review, pm_effort_points: 8) was never updated after that. Of the FEAT's own acceptance list (repo/project/agent/agentMode/entity/since/as_of), 5 of 7 (repo/project/agent/entity/since) are on the registry today. The remaining 2 are deliberately NOT column-filter shaped: `agentMode` selects between hard-filter vs. soft-boost composition for `agent` (src/search/search.ts:68, :410-413) and `as_of` drives the bitemporal validity WHERE-clause already centralized in the single `validityFilterClause()` function (src/search/search.ts:211-216) rather than being duplicated per-surface — i.e. the N-file shotgun-edit failure mode this FEAT targeted does not apply to either, so 'migrate them onto the registry too' would be forcing a shape mismatch, not closing a gap. No open engineering-pain signal remains: the last new filter added (since, SLICE-B) touched exactly one registry entry, confirming the fix works. Remaining action is administrative (close the backlog item), not build work — hence effort_points: 1, technical_risk: 0.05, autonomous_safe: true. Recommend this file move to backlog/done/ on the next runner:close-style pass; left in triaged/ per this rescore task's explicit instruction not to move it."
pm_demand_evidence: "Internal engineering-pain evidence (not end-user facing): triage_notes quotes 'at least the 4th repetition of the identical pattern' and the FEAT body names the exact ~8-file lockstep edit. Cross-referenced against source: src/search/fuse.ts (222 lines) and src/search/search.ts (now 558 lines, was 513) confirm these are real, actively-edited files — but the demand has since been satisfied (see pm_superseded_note)."
pm_scope_notes: "Superseded — see pm_superseded_note. No further decomposition needed; nothing left to slice."
pm_risks:
  - "None material remaining. The over-engineering risk originally flagged (forcing a registry onto working filters) did not materialize: the shipped registry is a thin, generic-over-descriptors module (354 lines) with per-filter behavior preserved via explicit presence-predicate functions documented as 'byte-identical, not fixed' — not a heavier codegen abstraction."
  - "Residual: if a future filter needs a genuinely new apply-kind (a 3rd shape beyond sqlColumn/sqlRangeColumn/custom), the registry's FilterApply union will need a real extension — low likelihood, not a reason to keep this FEAT open."
reasoning: "Composite score dropped from 0.41 to ~0.09 because the work is already done: customer_impact and strategic_alignment are now scored as residual/administrative value only (closing a stale doc), not as unbuilt capability. technical_risk collapsed from 0.50 (new pattern, unproven) to 0.05 (pattern shipped, tested, and already proven itself against a real new-filter addition). effort_points dropped from 8 to 1 since there is no design decision or build left, only bookkeeping. No decomposition gate applies at this size."
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
