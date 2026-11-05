---
id: PM-REVIEW-FEAT-554
feature: FEAT-554
reviewed_at: 2026-11-05
pm_customer_impact: 0.45
pm_effort_estimate: 0.3
pm_strategic_alignment: 0.5
pm_technical_risk: 0.25
pm_dependency_depth: 0.05
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-554

## Demand Assessment

- **Evidence:** Operator-verified gap, dated 2026-11-05 in docs/memory.md 'Known open gaps': 'Agent provenance IS captured but the dashboard never exposes it' - memories.agent at 98.7% coverage, 450 distinct values, claude-code about 105k main-session rows, then crew:reviewer 1180, crew:fullstack-dev 1158, general-purpose 613, crew:researcher 604, runner:pm 248, caveman:cavecrew-investigator 63. I verified the three load-bearing claims rather than trusting the FEAT text. (1) The column is already filterable: AgentFilterSchema in src/contracts/recall-filters.ts:75 documents 'filters.agent - exact match on provenance agent/agent_type. A single string is agent = ?, a string[] is agent IN (...). AND-composes with project when both are present.' (2) The index exists: migrations/019-health-agent-profile-indexes.sql creates idx_memories_agent on memories(agent, valid_to, archived, type, created_at DESC), added because buildAgentProfile issued 4+ WHERE agent = ? queries against an unindexed column and measured a 26x cliff at 100k rows. (3) The dashboard genuinely lacks it: src/server/routes/dashboard-html.ts:396-397 renders exactly two selects, project and profile, and src/server/queries/dashboard.ts:129 types filterOptions as { projects: string[]; profiles: string[] } with no agent member. Demand is operator-observed, not user-reported - no bug report, no grade lesson, and no spec mandate names this. A real workaround exists and that caps impact: recall and search already filter by agent via --agent, so the missing piece is dashboard visibility rather than capability. Partly offset by demo exposure - commit 81b0d2e0 added an investor demo runbook, and the dashboard is the surface a demo shows.

## Scope Challenge

- **Scope notes:** SCOPE CONFIRMED as small and well-patterned. The filter plumbing is already factored for exactly this kind of extension, and I traced every touch point: MemoryListFilters (src/server/queries/dashboard.ts:139), the NONE_FILTER_VALUE sentinel (:146), parseMemoryFilterParam (:148), the AND-composed condition builder in queryRecentMemories (:226-253), the filterOptions assembly (:441), then renderMemoryFilterForm with its shared buildOptions closure (src/server/routes/dashboard-html.ts:383-399), isMemoryFilterActive (:367), filterQueryValue (:373), and the pager's param preservation (:480-492). Adding a third dimension is mechanical at each site. The agent condition is strictly SIMPLER than what already ships: memories.agent is a real indexed column so the clause is agent = ?, where the existing profile filter already carries a correlated subquery over transcripts ordered by ingested_at. Two files, no schema change, no wire-contract change.

THE ONE DESIGN-SENSITIVE PIECE: 450 distinct values will not render as a flat select. The FEAT proposes optgroup-per-plugin-prefix, a top-N cap by memory count, and a free-text fallback for the ad-hoc Agent(name=...) labels such as reviewer-420 and arch-454 that share the column. That is the right shape and it is the part a builder should not improvise - AC-1 and AC-6 pin it down. The core-vs-prefixed split matters: claude-code and general-purpose carry no prefix and need their own group.

WHAT I WOULD CUT if halving scope: the free-text fallback. Shipping the grouped top-N dropdown alone delivers the value, and the deep link in AC-3 already lets any capped-out agent be reached by URL. Keep the dropdown, the filtering, the pagination, and the escaping.

NO OVERLAP: this does not duplicate FEAT-423/424 (recall-side agent filter, both in backlog/done) or the agent-profile endpoint behind migration 019. Those are the CLI and API surfaces; this is the dashboard surface only. Out-of-scope boundaries in the FEAT are correct - it changes neither what agent_type the plugin sends nor recall ranking.

PERFORMANCE CAVEAT worth an explicit AC, which is why technical_risk is 0.25 rather than 0.15: queryProjectOptions (src/server/queries/dashboard.ts:276) already runs an unbounded SELECT DISTINCT over memories on every render, so a naive copy inherits that. But the FEAT asks for top-N BY MEMORY COUNT, which turns it into a GROUP BY over roughly 120k rows per dashboard load. This repo has a live incident class for unbounded scans: docs/memory.md hard-locks memory-health to tier full after incident #226, and records a 31.9s event-loop stall plus a 30s vec-search timeout observed 2026-11-05 on v0.22.1. The aggregation must ride idx_memories_agent with an explicit LIMIT - AC-6.

WEAK DIMENSIONS (Framework 4, from .claude/artifacts/loop/loop-snapshot.md 'Last 5 averages'): all seven flagged below 0.80 - architecture_quality 0.686, reliability 0.425, observability 0.325, production_readiness 0.51, security 0.6, test_confidence 0.637, product_completeness 0.51. Same caveat as FEAT-553: those averages are depressed by graders leaving dimensions at the template default 0 in .claude/artifacts/loop/grades/20260718T022347Z-feat544-slice439-grade.md and 20260718T020755Z-feat542-slice438-grade.md, and the only genuinely populated downward trend is observability at about 0.75. autonomousSafe is true only because I have written an AC per flagged dimension: AC-7 observability, AC-3/AC-4 reliability, AC-6 production_readiness, AC-5 security, AC-8 test_confidence, AC-2/AC-4 architecture_quality by reusing MemoryListFilters and parseMemoryFilterParam instead of a parallel code path, AC-1/AC-3 product_completeness.

EFFORT CALIBRATION (Framework 5): no cost analog for a dashboard-filter-only change. The nearest aggregates, .claude/artifacts/crew/cost/20260710T135102Z-cost-report-aggregate-feat463-slice421.md at usd 223.84 over 5 sources and 20260709T110619Z-cost-report-aggregate-feat441-slice419.md at usd 221.74 over 4 sources, are both multi-source runs on substantially larger scope and would badly over-predict this. Effort 0.3 is scored from the dimension table: 2 files, an established 8-site pattern, one design decision on option grouping. 0.3 maps to 3 points, below the 8-point FEAT-168 threshold, so no decomposition is required and proposedSlices is omitted deliberately.

FIX CLASSIFICATION: neither rule fires - the body is not titled fix: or hotfix: and declares no relates_to: line - so category and relates_to are omitted per rule 4.

## Scores

- customer_impact: 0.45
- effort_estimate: 0.30
- strategic_alignment: 0.50
- technical_risk: 0.25
- dependency_depth: 0.05

## Priority Derivation

composite_priority: P2
autonomous_safe: true
reasoning: P2: operator-verified dashboard gap with a genuine workaround (recall and search already filter by agent via --agent / filters.agent, src/contracts/recall-filters.ts:75), so impact is 0.45 rather than higher; effort 0.3 because the filter plumbing is already factored across 8 well-commented touch points and the agent clause (agent = ?, on indexed idx_memories_agent from migrations/019) is simpler than the correlated-subquery profile filter already shipping; technical_risk 0.25 sits just above the 0.0-0.2 band - 2 files and a clean git revert qualify for it, but rendering 450 free-text values and aggregating top-N over ~120k rows on the render path are real enough to warrant explicit escaping and bounded-query ACs; dependency_depth 0.05 as data, index and filter contract all already exist; autonomousSafe=true with an AC per flagged weak dimension; effort maps to 3 points so no decomposition is required.

## Risks

- OPTION-LIST EXPLOSION is the main design trap: 450 distinct agent values, most of them long-tail ad-hoc Agent(name=...) labels, against two existing dropdowns that render every distinct value flat. A builder copying queryProjectOptions verbatim ships an unusable 450-entry select. AC-1 and AC-6 force the grouped, capped shape.
- UNBOUNDED AGGREGATION ON THE RENDER PATH: top-N by memory count is a GROUP BY over roughly 120k memories on every /dashboard load. The repo's own precedent says this is the dangerous shape - memory-health is hard-locked to tier full by FULL_TIER_ONLY_CHECK_NAMES in tests/doctor/schedule.test.ts after incident #226 promoted its unbounded scans to a 15-min tick, and docs/memory.md records a 31.9s event-loop stall on 2026-11-05. Must ride idx_memories_agent (migrations/019) with an explicit LIMIT. AC-6.
- XSS SURFACE VIA A FREE-TEXT COLUMN: memories.agent holds operator-chosen Agent(name=...) labels, so its values are not a closed vocabulary. The existing buildOptions closure (src/server/routes/dashboard-html.ts:385-390) already wraps every option in esc(), and the activity-feed cells at :455-456 do the same - the new option list and the new feed column must both go through esc() rather than string-concatenating raw values. AC-5 asserts it by checking the raw markup does not appear unescaped.
- JOB-FAILURE CARVE-OUT IS EASY TO MISS: isMemoryFilterActive (src/server/routes/dashboard-html.ts:367) returns filters.project !== undefined || filters.profile !== undefined, and the merged activity feed drops job-failure rows when it is true because those rows carry no project or profile of their own. Omitting the agent dimension from that predicate leaves unfiltered job-failure rows showing underneath a view the user asked to narrow. AC-4.
- PAGINATION PARAM DROP: renderActivityPager (:480-492) rebuilds its URL from scratch with URLSearchParams and only re-adds project and profile. An agent filter not added there silently clears on page 2 - the classic failure of this pattern. AC-3.
- THE none SENTINEL IS A SEPARATE CODE PATH, not free: parseMemoryFilterParam (:148-163) maps the literal 'none' to null, and callers must then emit IS NULL rather than = ?. With 98.7% agent coverage the IS NULL branch covers roughly 1,500 rows, so it is reachable in practice and must be tested, not assumed. AC-4.
- PRE-MORTEM-STYLE COVERAGE GAP (noted even though technical_risk is below the 0.6 mandate, because it is cheap to state): no existing test exercises a third filter dimension, so nothing today would catch an agent param that is parsed but silently dropped before the WHERE clause. The existing project/profile assertions in tests/server/dashboard-html.test.ts and tests/server/queries/dashboard-queries.test.ts would all still pass. AC-8 requires mirrored tests rather than relying on the existing suite.
- ROLLBACK is a clean git revert: two files, no migration, no wire-contract change, and idx_memories_agent already exists independently from migration 019. This is the low-risk half of the pair with FEAT-553.
- INJECTION CHECK: no embedded imperative or prompt-injection attempt found in the FEAT-554 body. Every figure it cites reconciles with docs/memory.md and with the source files I read.
