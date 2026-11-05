---
id: FEAT-554
status: in-progress
priority: P2
category: feature
target_release: null
created: 2026-11-05
updated: 2026-11-05
depends_on: []
slices: [SLICE-448]
derived_from: null
pm_customer_impact: 0.45
pm_effort_estimate: 0.3
pm_strategic_alignment: 0.5
pm_technical_risk: 0.25
pm_dependency_depth: 0.05
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-11-05
autonomous_safe: true
triage_notes: "P2: operator-verified dashboard gap with a genuine workaround (recall and search already filter by agent via --agent / filters.agent, src/contracts/recall-filters.ts:75), so impact is 0.45 rather than higher; effort 0.3 because the filter plumbing is already factored across 8 well-commented touch points and the agent clause (agent = ?, on indexed idx_memories_agent from migrations/019) is simpler than the correlated-subquery profile filter already shipping; technical_risk 0.25 sits just above the 0.0-0.2 band - 2 files and a clean git revert qualify for it, but rendering 450 free-text values and aggregating top-N over ~120k rows on the render path are real enough to warrant explicit escaping and bounded-query ACs; dependency_depth 0.05 as data, index and filter contract all already exist; autonomousSafe=true with an AC per flagged weak dimension; effort maps to 3 points so no decomposition is required."
tags: [ux, storage, test]
needs_contract: false
needs_ux: false
started_at: 2026-11-05
---
## Description

Dashboard: add an `agent` filter dropdown so memories can be browsed by the agent that produced them (builder, researcher, reviewer from dev-crew/crew/runner/caveman plugins, core claude-code, general-purpose, workflow-subagent). The data already exists: `memories.agent` is populated from the SubagentStop hook payload's `agent_type` (98.7% coverage; 450 distinct values as of 2026-11-05 — `claude-code` 105,005 main-session rows, `crew:reviewer` 1,180, `crew:fullstack-dev` 1,158, `general-purpose` 613, `crew:researcher` 604, `crew:backend-dev` 602, `workflow-subagent` 509, `runner:pm` 248, `caveman:cavecrew-investigator` 63, `devcrew:*` 3; plugin = text before `:`). Recall/search already filter on it (`--agent`, `filters.agent`, FEAT-423/424; index from migration 019) — only the dashboard lacks it: Mission Control has project + profile dropdowns only (src/server/routes/dashboard-html.ts:396-397, options from src/server/queries/dashboard.ts:276). Scope: add an `agent` <select> + `agent` query param next to project/profile; plumb it through the activity-feed filter, the job-failure carve-out, and pagination exactly like project/profile; options query `SELECT DISTINCT agent FROM memories WHERE agent IS NOT NULL` rendered as <optgroup> per plugin prefix (non-prefixed values such as claude-code/general-purpose under "(core)"), capped to top-N by memory count with a free-text fallback because ad-hoc Agent(name=…) labels (reviewer-420, arch-454) share the column; show the agent value as a column in the recent-activity rows; tests mirroring the existing project/profile filter tests. Out of scope: changing what agent_type the plugin sends; changing recall ranking. Acceptance: /dashboard shows an agent dropdown grouped by plugin; selecting one filters the activity feed and survives pagination; /dashboard?agent=crew:reviewer works as a deep link; project/profile filters unchanged (existing tests pass).

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Acceptance criteria (Given-When-Then)

- AC-1: Given the daemon is serving /dashboard and memories contains rows with agent values 'crew:reviewer', 'crew:fullstack-dev', 'runner:pm', 'claude-code', and 'general-purpose', When the page is rendered, Then renderMemoryFilterForm (src/server/routes/dashboard-html.ts:383) emits a third select named agent alongside the existing project and profile selects, with prefixed values grouped under optgroup labels 'crew' and 'runner' and the non-prefixed values claude-code and general-purpose grouped under a '(core)' optgroup.
- AC-2: Given the request /dashboard?agent=crew:reviewer, When queryRecentMemories (src/server/queries/dashboard.ts:226) builds its WHERE clause, Then an 'agent = ?' condition is AND-composed with any active project and profile conditions using the same conditions-array pattern already at :230-253, the activity feed contains only crew:reviewer rows, and the crew:reviewer option is rendered with the selected attribute.
- AC-3: Given an active agent filter and more than 15 matching memories (ACTIVITY_PER_PAGE, src/server/routes/dashboard-html.ts:360), When the next link produced by renderActivityPager (:480) is followed, Then the generated URL carries agent=crew:reviewer alongside page=2 and any project or profile params, and page 2 is still filtered to crew:reviewer.
- AC-4: Given the request /dashboard?agent=does-not-exist-anywhere, and separately /dashboard?agent=none, When each is rendered, Then the first returns HTTP 200 with an empty activity feed and no job-failure rows leaking into it because isMemoryFilterActive (:367) now also returns true for the agent dimension, and the second filters to 'agent IS NULL' via the NONE_FILTER_VALUE sentinel that parseMemoryFilterParam (:148) already implements for project and profile.
- AC-5: Given a memories.agent value containing HTML metacharacters, which is reachable because ad-hoc Agent(name=...) labels are free text (for example the literal string reviewer-420<script>alert(1)</script>), When that value is rendered both in the agent option list and in the new activity-feed agent column, Then it passes through the existing esc() helper, and a test asserts the response body contains no unescaped <script> substring.
- AC-6: Given a store holding roughly 120,000 memories across 450 distinct agent values, When the agent options query runs during a /dashboard render, Then it is a bounded top-N-by-count query with an explicit LIMIT that uses idx_memories_agent from migrations/019-health-agent-profile-indexes.sql rather than an unbounded full-table GROUP BY, and a free-text input accepts any value outside the top-N so a capped-out agent remains reachable.
- AC-7: Given the agent options query executes on a dashboard render, When it completes, Then its returned row count and elapsed milliseconds are emitted on the same structured dashboard-timing path the existing filter-option queries use, so a cost regression in that query is visible from logs without profiling.
- AC-8: Given the pre-existing project and profile filter assertions in tests/server/dashboard-html.test.ts and tests/server/queries/dashboard-queries.test.ts, When 'bun run test' and 'node contracts/validate.mjs' are run after the change, Then every pre-existing assertion passes unmodified and new tests mirroring them cover the agent dimension across the select rendering, the WHERE composition, the none sentinel, and pager param preservation.
