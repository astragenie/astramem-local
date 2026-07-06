---
id: FEAT-417
status: done
completed: 2026-07-04
priority: P2
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: arch-review-2026-07-04
pm_customer_impact: 0.40
pm_effort_estimate: 0.35
pm_strategic_alignment: 0.45
pm_technical_risk: 0.30
pm_dependency_depth: 0.30
pm_effort_points: 3
composite_score: 0.54
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "Phase-1 inventory gaps 1/3/4 (why/digest dedup, MCP as_of/entity parity, dead parseQuery code) — architecture review debt ranks 4-6, the lowest-ranked of the six debt items."
pm_scope_notes: "Overlap check done — does NOT duplicate already-shipped W5.5(d) fusion-weight normalization (cedc8a9); distinct concrete code batch sharing only review-debt-batching intent with W5.5. No file-level collision risk if both proceed. Keep the three sub-items batched in one slice."
pm_risks:
  - "Shared why/digest query function must preserve exact existing output for both callers, or the conformance test itself becomes the regression."
  - "parseQuery deletion needs the explicit product decision recorded in the FEAT's own AC (default: delete) — don't silently wire it in as a scope change instead."
reasoning: "Lowest-ranked debt item in the batch — real hygiene value but nothing here is currently causing incidents or blocking usage. Appropriately P2: worth batching into a slice, not urgent."
---
# FEAT-417: Review-debt batch 2 — why/digest dedup, MCP filter parity, parseQuery removal

## Problem
Three small items from the 2026-07-04 retrieval-surface inventory, batchable in one slice:
(a) GET /memory/:id/why and GET /sessions/:id/digest logic independently duplicated in mcp/server.ts tools — in sync today, no test forces agreement; trust-critical provenance surfaces.
(b) MCP search_memory/recall_memory schemas missing as_of + entity params (REST/CLI have both) — parity gap for MCP-driven agents.
(c) src/search/query.ts parseQuery() is dead code never imported; its unit test exercises unreachable code (false confidence).

## Acceptance
- (a) Shared query fn consumed by both route and MCP tool; conformance test asserting identical output for same id.
- (b) as_of + entity optional params added to the two MCP tool schemas, wired to existing search filters; MCP tool test extended.
- (c) parseQuery + its test deleted (or wired in with a product decision recorded — default: delete).

## Evidence
Phase-1 inventory gaps 1/3/4; architecture review debt ranks 4-6. Overlaps W5.5 review-debt batch intent (distinct items — see pm_scope_notes).


## Resolution (2026-07-04, Wave A)
Merged 1bc7203: getWhyReceipt/getSessionDigest shared queries + deep-equal conformance tests; MCP search/recall as_of+entity params inheriting REST seams; parseQuery+test deleted. FEAT-417a harmonization: MCP session_digest unknown explicit session_id now errors (REST semantics won). Review PASS.

