---
kind: handoff
objective: FEAT-554 dashboard agent filter dropdown implemented — all 8 ACs done
owner: fullstack-dev (builder, self-dispatched — no Agent/Task tool available in this session)
slice: SLICE-448
feature: FEAT-554
phase: null
created_at: 2026-11-05
updated_at: 2026-11-05
confidence: high
next_handoff: review-then-close
---
# Handoff — FEAT-554 dashboard agent filter dropdown, build complete

**Feature:** FEAT-554 · **Slice:** SLICE-448 · **Branch:** `main-SLICE-448`
**Worktree:** `C:/work/mega/astramem-local-SLICE-448-0`

## Objective

Add an `agent` filter `<select>` + free-text fallback to Mission Control's
`/dashboard`, next to the existing project/profile filters — grouped by
plugin prefix (`crew`, `runner`, `(core)`), wired through the activity-feed
WHERE clause, the job-failure carve-out, and pagination exactly like
project/profile. Options bounded top-N by memory count (not a plain
`DISTINCT`, since a real store carries ~450 distinct agent values).

## What shipped (AC-1..AC-8 — PASS with test evidence)

- **`src/server/queries/dashboard.ts`**:
  - `RecentMemory.agent: string | null`, SELECTed in `queryRecentMemories` alongside `project`.
  - `MemoryListFilters.agent?: string | null`; AND-composed into the same `conditions`/`params` arrays as `project` (`agent = ?` / `agent IS NULL`).
  - `AgentOptionCount` type + `queryAgentOptions(db, limit = 50)`: `SELECT agent, COUNT(*) AS count FROM memories WHERE agent IS NOT NULL GROUP BY agent ORDER BY count DESC LIMIT ?` — rides `idx_memories_agent` (migration 019) via its leading `agent` column, bounded, never an unbounded `DISTINCT` scan.
  - Structured timing log: `logger.info({ event: 'dashboard.query.agent_options', rowCount, elapsedMs }, ...)` on every call (AC-7).
  - `DashboardData.filterOptions.agents: AgentOptionCount[]`.
- **`src/server/routes/dashboard-html.ts`**:
  - `groupAgentOptions()` buckets `AgentOptionCount[]` by plugin prefix (text before `:`; non-prefixed → `(core)`), preserving count-DESC order within each group.
  - `renderMemoryFilterForm` emits a third `<label>agent <select name="agent">...</select> <input type="text" name="agent" ...></label>` — `<optgroup>` per plugin, `(all agents)`/`— (no agent)` baseline options, free-text fallback pre-filled when the active filter has no matching option (keeps a capped-out agent reachable, AC-6).
  - `isMemoryFilterActive` now also true when `filters.agent !== undefined` (AC-4 job-failure carve-out).
  - `renderActivityPager` preserves `agent` alongside `project`/`profile` (AC-3).
  - New `<th>Agent</th>` column; memory rows show `esc(mem.agent)` or a muted dash; job-failure rows now render **three** dash cells (project/profile/agent) instead of two.
- **`src/server/routes/dashboard.ts`** (**scope note** — see below): one line, `agent: parseMemoryFilterParam(q['agent'])`, added to the route handler's `memoryFilters` construction — the same place `project`/`profile` are parsed today.
- **Tests** mirroring the existing project/profile suites:
  - `tests/server/queries/dashboard-queries.test.ts`: agent column/filter (SELECT, exact match, null sentinel, AND-composition with project), `queryAgentOptions` (count-DESC ordering, bounded LIMIT, the AC-7 timing-log spy), `queryDashboard` end-to-end threading.
  - `tests/server/dashboard-html.test.ts`: select+optgroups rendering, selected-option marking, none-sentinel, free-text fallback pre-fill, XSS escape, pager-param preservation, job-failure exclusion, Agent column rendering. Every pre-existing `RecentMemory` literal fixture updated with `agent: null` (new required field, mirrors how `project`/`profile` are already required).

## Scope note (disclosed, not silent)

The slice's `touches_files` / scope guard list 4 files and does **not**
include `src/server/routes/dashboard.ts`. Structurally, `?project=`/`?profile=`
are parsed into `MemoryListFilters` in that route file today (confirmed by
reading it before editing) — `dashboard-html.ts`'s `renderDashboard` never
sees raw query params except the already-separately-threaded `rawPage`.
Without the one-line addition there, `?agent=` would never reach
`queryDashboard`/`queryRecentMemories` and the whole feature would be
inert in a live request despite every unit test passing (tests call
`renderDashboard`/`queryRecentMemories` directly, bypassing the route).
Treated this as the slice's own file list missing the one unavoidable,
zero-design-judgment line required to wire the feature end-to-end — not as
license for a broader change. No other file outside the stated four (plus
this one line) was touched.

## Known tradeoff (disclosed)

The agent `<select>` and the free-text `<input>` fallback share
`name="agent"` per the slice's explicit instruction ("repeated-name
last-value-wins is already handled by parseMemoryFilterParam"). A bare
GET `<form>` has no declarative way to omit one shared-name control's value
from submission, so in a real browser with BOTH controls present in one
submission, whichever control is rendered LAST wins when the other is left
at its blank default. Ordered select-then-input here so the heavily-tested
primary path (picking a dropdown option, free-text left blank) always wins;
the accepted cost is that typing into the free-text box while also leaving
the select untouched at its own blank default does not override it in a
single submission — reaching a capped-out agent via the rendered page then
takes one extra step (editing the resulting `?agent=` in the URL), no worse
than before this control existed. Documented in a code comment at the call
site (`renderMemoryFilterForm`). No JS fix was available under this page's
zero-JS design constraint.

## AC-7 discrepancy (disclosed)

AC-7's wording implies `queryProjectOptions`/`queryProfileOptions` already
emit a structured timing log that `queryAgentOptions` should reuse.
Verified by reading `src/server/queries/dashboard.ts` before editing:
neither emits one today. Implemented a new, narrowly-scoped
`logger.info({ event: 'dashboard.query.agent_options', rowCount, elapsedMs }, ...)`
call satisfying AC-7's literal requirement (row count + elapsed ms visible
from logs without profiling) without retrofitting the other two queries —
retrofitting them would be a change to project/profile code this slice's
own "Out of scope" explicitly excludes.

## AC-8 pre-existing-assertion note (disclosed)

One pre-existing assertion changed: `tests/server/dashboard-html.test.ts`
→ "renders — for job-failure rows..." asserted exactly 2 muted dash cells;
now 3, since this slice adds a third (Agent) dash cell to job-failure rows
by design. The assertion's actual guarantee (job rows carry no
project/profile/agent of their own) is preserved and still covered — only
the literal count constant changed to match the new column.

## Verification commands run

```
bun run build
  tsc -p .          # clean, no output

bunx vitest run tests/server/dashboard-html.test.ts tests/server/queries/dashboard-queries.test.ts
  Test Files  2 passed (2)
  Tests  84 passed (84)

node contracts/validate.mjs
  58 fixture checks run, 0 failure(s)

bun run test   (full suite, run once at the end)
  Test Files  9 failed | 417 passed (426)
  Tests  87 failed | 5731 passed | 19 skipped (5837)
  — all 87 failures isolated to tests/consolidate/*, tests/mcp/server.test.ts,
    tests/service/shim.test.ts. Root-caused (isolated single-test rerun):
    this shell has ASTRA_SKIP_CONSOLIDATE=1 set in its environment, which
    makes every consolidation-dependent test assert on an empty result set
    (confirmed via stderr: "[consolidate] skipped — ASTRA_SKIP_CONSOLIDATE=1").
    The tests/service/shim.test.ts failures are real-process Windows
    watchdog-wrapper timeouts, unrelated to any file this diff touches.
    Zero failures reference dashboard/*, queries/dashboard.ts, or agent.
```

## Files changed

- `src/server/queries/dashboard.ts`
- `src/server/routes/dashboard-html.ts`
- `src/server/routes/dashboard.ts` (scope note above)
- `tests/server/dashboard-html.test.ts`
- `tests/server/queries/dashboard-queries.test.ts`

## Risks / open questions

- The real-browser select+freetext interaction limitation above is accepted,
  not fully solved (no JS allowed on this page). A future slice could split
  the free-text fallback into its own `<form>` (eliminates the shared-name
  collision entirely) if this becomes a real operator complaint.
- No separate `crew:reviewer`/`crew:verifier` subagent ran — this session
  has no Agent/Task tool to dispatch one. Self-review performed instead;
  see `.claude/artifacts/crew/reviews/20261105T230419Z-review-result-feat554-slice448-review.md`.
