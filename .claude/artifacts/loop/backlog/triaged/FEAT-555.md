---
id: FEAT-555
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-11-06
updated: 2026-11-06
depends_on: []
slices: []
derived_from: null
pm_customer_impact: 0.5
pm_effort_estimate: 0.4
pm_strategic_alignment: 0.35
pm_technical_risk: 0.45
pm_dependency_depth: 0.05
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-11-06
autonomous_safe: false
triage_notes: "P2, autonomousSafe false: operator-authored follow-up explicitly parked at docs/memory.md:181 with a quantified gap (25 of 1,180 agent-filtered rows reachable) but a tolerable Search/recall workaround, so customer_impact 0.5 and strategic_alignment 0.35 — dashboard operability supports the local-first memory-daemon mission without being its retrieval-quality centerpiece. technical_risk 0.45 sits at the top of the 0.3-0.5 band deliberately: one module, no contract or schema change and a clean git revert keep it out of the 0.6+ band, but verified-absent created_at index coverage plus the profile filter's per-row correlated subquery make an added COUNT a genuine event-loop hazard on a synchronous better-sqlite3 render path. effort 0.4 maps to 5 points (under the 8-point gate, no decomposition) and bumps one band above the SLICE-448 analog that actually cost $13.47 / 36.25M tokens / 56 min at a predicted 3 points and still took two fix rounds. autonomousSafe is false for two settle-first items, not for AC vagueness: the FEAT's own 150 ms whole-render AC is unachievable alongside its no-new-indexes exclusion on a page already cold-rendering ~7.9s at 16k rows, and pinning job-failure rows to page 1 changes shipped merge-and-sort behaviour and the meaning of 'of Z'. ACs 1-8 resolve both under stated assumptions, so the slice is dispatch-ready the moment an operator confirms them."
tags: [storage, ux, test, refactor]
needs_contract: false
needs_ux: false
---
## Description

Dashboard activity feed: page through the FULL filtered history instead of a fixed 25-row window. Today queryRecentMemories (src/server/queries/dashboard.ts) hard-codes LIMIT 25 and renderActivityPager (src/server/routes/dashboard-html.ts, ACTIVITY_PER_PAGE=15) pages only inside that window, so a filter like /dashboard?agent=crew:reviewer shows at most 25 of 1,180 matching memories (2 pages) and older ones are unreachable except via the Search tab. Scope: replace the fixed LIMIT with offset/keyset paging on the filtered query (page size 15, keep project/profile/agent filters and the ?page= param), a total-count query for the caption (page N/M, showing X-Y of Z) that reuses the same WHERE composition, bounded (LIMIT/OFFSET or keyset on created_at,id) so a 120k-row store stays fast on the existing indexes, job-failure rows only on page 1 when no filter is active (current behaviour), tests mirroring tests/server/dashboard-html.test.ts and tests/server/queries/dashboard-queries.test.ts (pager links keep all filters, last page clamps, zero-match filter renders page 1/1 empty). Out of scope: Search tab, recall ranking, new indexes/migrations. Acceptance: /dashboard?agent=crew:reviewer&page=50 shows rows 736-750 of 1,180; caption and prev/next correct; p95 render under 150 ms on the 120k store; existing project/profile/agent filter tests unchanged.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Acceptance criteria (Given-When-Then)

- AC-1: Given a store where memories.agent = 'crew:reviewer' matches 1,180 of ~120,000 rows, When an operator requests /dashboard?agent=crew:reviewer&page=50, Then queryRecentMemories (src/server/queries/dashboard.ts:263) returns exactly the 15 rows at SQL offset 735 ordered created_at DESC, and renderActivityPager (src/server/routes/dashboard-html.ts:537) renders the caption 'page 50/79 - showing 736-750 of 1180' with both a working prev and a working next anchor.
- AC-2: Given the MemoryListFilters WHERE composition inside queryRecentMemories (the conditions/params arrays at src/server/queries/dashboard.ts:264-300, covering project equality, project IS NULL, the transcripts correlated-subquery profile clause, profile IS NULL, agent equality and agent IS NULL), When the new total-count query is built, Then it consumes that same single composition extracted to one shared helper rather than a second hand-written WHERE, and a test asserts the count equals the number of rows the page query can reach for every filter shape already pinned in tests/server/queries/dashboard-queries.test.ts:232-376.
- AC-3: Given an agent filter value matching no stored row - the ?agent=does-not-exist-anywhere case already pinned for the row query at tests/server/queries/dashboard-queries.test.ts:370 - When /dashboard renders with that filter, Then the total count is 0, the caption reads 'page 1/1', renderActivityPager emits no prev or next anchor (it returns the empty string at total === 0), the response status is 200, and the feed shows its empty-state text rather than falling back to the unfiltered set.
- AC-4: Given a filtered history of 1,180 matching rows (79 pages at 15 per page), When ?page= is supplied as '0', 'abc', '-5' or '999999', Then resolveActivityPage (src/server/routes/dashboard-html.ts:527) clamps to 1, 1, 1 and 79 respectively, and the rows actually rendered are the rows at that clamped page's SQL offset - asserted against a real DB fixture built with the insertMemory helper (tests/server/queries/dashboard-queries.test.ts:224), not a baseData({ recentMemories }) in-memory array.
- AC-5: Given a seeded store of 120,000 memories rows, When the two activity-feed statements (the filtered page query and the filtered total-count query) are timed in isolation over 20 runs for ?agent=crew:reviewer&page=50, Then their combined p95 is under 150 ms and the validation artifact records both the measured p95 and the EXPLAIN QUERY PLAN output for each statement. Given the budget is missed, When the cause is a missing index, Then the slice reports FAIL with that evidence and stops - it must not add an index or migration, which the FEAT body places out of scope, and it must not quietly restate the budget against the whole-page render, which already cold-renders in ~7.9s at 16k memories (src/server/routes/dashboard-html.ts:628-633).
- AC-6: Given the activity-feed page query or total-count query executes during a GET /dashboard, When either statement's elapsed time exceeds 250 ms, Then a single structured warn event is emitted through the logger already imported at src/server/queries/dashboard.ts:11, carrying the active filter keys, the resolved page, the SQL offset and the elapsed milliseconds - so a recurrence of the 2026-07-13 synchronous-render wedge (src/server/routes/dashboard-html.ts:628-645) is visible in logs instead of inferred from a dead /health.
- AC-7: Given no memory filter is active (isMemoryFilterActive returns false, src/server/routes/dashboard-html.ts:369) and queryRecentFailedJobs returns up to 10 rows (src/server/queries/dashboard.ts:412), When the feed renders, Then those job rows appear above the memory rows on page 1 only, pages 2 and later contain memory rows exclusively, and the caption's Z counts memories alone with the job-row count stated separately. Given any project, profile or agent filter IS active, When any page renders, Then no job row appears on it - preserving the existing carve-out documented at src/server/routes/dashboard-html.ts:476-480.
- AC-8: Given the five existing pagination tests at tests/server/dashboard-html.test.ts:264-312 construct recentMemories as 20-element in-memory fixtures and exercise no SQL (their own comment reads 'in-memory slice over the already-fetched rows (no new SQL)'), When paging moves into queryRecentMemories, Then at least one new DB-backed test inserts more than 30 rows via insertMemory (tests/server/queries/dashboard-queries.test.ts:224), calls the query at page 1 and page 3, and asserts the two returned id sets are disjoint and jointly ordered created_at DESC; and the untouched filter deep-link assertions at tests/server/dashboard-html.test.ts:470 and :543 still pass.
