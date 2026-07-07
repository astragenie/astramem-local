---
findings: "🔴:0,🟡:0,❓:2"
status: completed
decision: approved
---
# Review Result: Review Result

- Created: 2026-07-07T12:41:12.351Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: repo/since registry migration is behavior-preserving; all removed-code semantics (truthy repo gate, !==undefined since gate incl. since=0, NaN-drop parse) verified byte-identical against the diff, build+84/84 targeted tests incl. ADR-005 recall-floor gate pass green.
- Evidence Checked:
  - Line-by-line diff verification in src/contracts/filter-registry.ts (scalarColumnFilter/numericRangeColumnFilter factories
  - applySqlRangeFilters)
  - src/search/search.ts
  - src/server/routes/search.ts against removed hand-rolled code; bun run build clean (tsc -p .); bunx vitest run tests/contracts/filter-registry.test.ts (38 passed) + tests/server/search.test.ts (32 passed
  - incl. pre-existing e2e 'filters by repo param' test) + tests/eval/retrieval-eval.test.ts (14 passed
  - ADR-005 recall@10/NDCG@10 floors held) = 84/84 green.
- Files Reviewed:
  - src/contracts/filter-registry.ts
  - src/contracts/recall-filters.ts
  - src/search/search.ts
  - src/server/routes/search.ts
  - tests/contracts/filter-registry.test.ts
- Test Adequacy: New unit tests directly cover the regression-risk edges named in the task: since=0 (structured presence + SQL builder), empty-string repo (structured absence), NaN-since dropped (query-string parse), and cross-filter isolation (project never becomes a range clause, since never becomes an sqlColumn clause); plus a pre-existing e2e route test already exercises repo end-to-end.
- Risks: LOW: post-fusion WHERE clause order changed (was type,repo,project,agent,since; now type,project,agent,repo,since) — semantically inert since AND is commutative and params stay index-aligned with clauses, no test asserts clause order, but noting for the record. LOW: src/mcp/server.ts (untouched by this diff) still hand-rolls repo/since parsing outside the registry; now that repo/since are in RECALL_FILTER_REGISTRY, its assignStructuredFilterValues(args, filters) call will also redundantly (but identically) assign repo/since — harmless today, but leaves MCP as a natural follow-up to fully retire the hand-rolled blocks.
- Required Follow-up: Optional follow-up: migrate src/mcp/server.ts search_memory/recall_memory repo+since handling onto the registry (drop the now-redundant hand-rolled if-blocks) for full surface parity; not required for this slice.

