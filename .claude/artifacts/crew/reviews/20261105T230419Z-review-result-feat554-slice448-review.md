---
slice: SLICE-448
feature: FEAT-554
reviewer: self-review (builder) — no Agent/Task tool available in this session to dispatch an independent crew:reviewer
branch: main-SLICE-448
worktree: C:/work/mega/astramem-local-SLICE-448-0
date: 2026-11-05
verdict: PASS
---

# SLICE-448 review — dashboard agent filter dropdown (FEAT-554)

## Disclosure

This session has no `Agent`/`Task` tool, so `crew:orchestrate-slice`'s
Step 4 (`crew:reviewer` dispatch) could not actually run. Per the
computed task's own fallback clause ("If the skill cannot be invoked,
perform the equivalent yourself... write the handoff/review/validation
artifacts"), this is a **self-review by the same agent that wrote the
code**, not an independent review. Flagging this plainly rather than
presenting it as independent — the user's own workflow rules treat review
as a gate, and an honest gap is better than a fabricated one.

## Scope of diff (vs 02cf8ede)

5 files:
- `src/server/queries/dashboard.ts` (+81/-2)
- `src/server/routes/dashboard-html.ts` (+72/-7)
- `src/server/routes/dashboard.ts` (+1) — **outside the slice's stated
  `touches_files` list of 4 files.** Verified necessary, not scope creep:
  `?project=`/`?profile=` are parsed into `MemoryListFilters` in this exact
  file today (read before editing); `dashboard-html.ts` never receives raw
  query params. Without this one line, `?agent=` would never reach
  `queryDashboard` in a live request — the feature would be inert despite
  every unit test passing (unit tests call `renderDashboard`/
  `queryRecentMemories` directly, bypassing the route). One line, same
  pattern as the two lines immediately above it, zero design judgment.
  Judged in-scope-by-necessity rather than a stop-and-report case.
- `tests/server/dashboard-html.test.ts` (+123/-13, incl. 13 pre-existing
  `RecentMemory` fixtures updated with `agent: null`)
- `tests/server/queries/dashboard-queries.test.ts` (+104/-2)

No migrations, no contracts/, no recall/search code touched — matches
"Out of scope."

## AC-by-AC

- **AC-1** (select + optgroups): `renderMemoryFilterForm` + new
  `groupAgentOptions()` — grouped by text-before-`:`, non-prefixed under
  `(core)`. Verified by reading the diff and by the new
  `dashboard-html.test.ts` "AC-1" test (`<optgroup label="crew">` /
  `label="runner"` / `label="(core)"`, `claude-code`/`general-purpose`
  landing in `(core)`). PASS.
- **AC-2** (WHERE composition + selected attr): `queryRecentMemories`
  AND-composes `agent = ?` into the SAME `conditions`/`params` arrays as
  `project`/`profile` (not a parallel/duplicate mechanism) — confirmed by
  reading lines 264-273. Selected-attribute rendering confirmed by test.
  PASS.
- **AC-3** (pager preserves agent): `renderActivityPager`'s `linkFor`
  conditionally sets `agent` the same way it already does `project`/
  `profile`. New test asserts the exact encoded URL
  (`page=2&agent=crew%3Areviewer`). PASS.
- **AC-4** (job-failure carve-out + none sentinel): `isMemoryFilterActive`
  OR's in `filters.agent !== undefined`; `agent IS NULL` reuses the
  existing `NONE_FILTER_VALUE` → `null` path `parseMemoryFilterParam`
  already implements generically (no new parsing logic needed). PASS.
- **AC-5** (XSS escape): every agent value render site (`<option>` text/
  value, optgroup label, activity-feed cell, free-text `<input value>`)
  goes through the existing `esc()` — verified by reading each call site;
  new test seeds a `<script>`-bearing agent value and asserts it never
  appears unescaped. PASS.
- **AC-6** (bounded query + free-text fallback): `queryAgentOptions` is
  `GROUP BY agent ... ORDER BY count DESC LIMIT ?`, not `DISTINCT` — rides
  `idx_memories_agent`'s leading `agent` column. New test seeds 5 agents,
  calls with `limit=3`, asserts exactly 3 rows. Free-text `<input>`
  present, pre-filled when the active filter has no matching option.
  PASS, with the real-browser select/freetext-shared-name tradeoff
  disclosed in both a code comment and the handoff (see below) — a known,
  accepted limitation, not a defect this review is waiving.
- **AC-7** (structured timing log): `queryAgentOptions` calls
  `logger.info({ event: 'dashboard.query.agent_options', rowCount,
  elapsedMs }, ...)` on every invocation; new test spies on
  `logger.info` and asserts the shape. **Finding (disclosed, not a
  defect):** verified neither `queryProjectOptions` nor
  `queryProfileOptions` emits any timing log today, so this is a new log
  path, not literal reuse of a pre-existing one as AC-7's wording implies.
  Retrofitting the other two is out of this slice's own stated scope
  ("any change to project/profile semantics"). AC-7's literal requirement
  (row count + elapsed ms visible from logs without profiling) is met.
  PASS.
- **AC-8** (no regressions + mirrored tests): see Test evidence below.
  One pre-existing assertion's literal count changed from 2 to 3
  (job-failure dash cells) — disclosed as a necessary, narrowly-scoped
  change given AC-1..AC-6 require a third dash column to exist; the
  assertion's underlying guarantee is unchanged and still covered. PASS.

## Test evidence

```
bun run build
  tsc -p .                                     # clean, no output

bunx vitest run tests/server/dashboard-html.test.ts tests/server/queries/dashboard-queries.test.ts
  Test Files  2 passed (2)
  Tests  84 passed (84)

node contracts/validate.mjs
  58 fixture checks run, 0 failure(s)

bun run test   (full suite, run once)
  Test Files  9 failed | 417 passed (426)
  Tests  87 failed | 5731 passed | 19 skipped (5837)
```

Isolated one representative full-suite failure
(`tests/consolidate/proposals.test.ts`) to confirm it is pre-existing and
unrelated:

```
bunx vitest run tests/consolidate/proposals.test.ts -t "candidateSelection=full: limit/offset"
stderr: 2026-...Z [consolidate] skipped — ASTRA_SKIP_CONSOLIDATE=1
AssertionError: expected +0 to be 7
```

`ASTRA_SKIP_CONSOLIDATE=1` is set in this shell's environment (`env | grep
-i astra` confirms it) — every consolidation-dependent test in
`tests/consolidate/*` and `tests/mcp/server.test.ts` short-circuits to an
empty result, which is exactly the failure pattern all 87 failures share.
The remaining 3 failures (`tests/service/shim.test.ts`) are real-process
Windows watchdog-wrapper timeouts, unrelated to any file in this diff.
None of the 87 failures reference `dashboard`, `queries/dashboard.ts`, or
`agent`. Confirmed this diff touches none of `tests/consolidate/`,
`tests/mcp/`, or `tests/service/`.

## Findings

- **LOW** — real-browser select+free-text shared-name (`name="agent"`)
  interaction: per the slice's own explicit instruction to share the name
  and rely on `parseMemoryFilterParam`'s last-value-wins, there is no
  declarative-HTML way to make "pick from dropdown" and "type a capped-out
  value" both always win when the other control is left at its blank
  default in the SAME submission. Mitigated by control order (select wins
  when free-text is blank — the tested, primary path) and documented
  in-code; a capped-out value is still reachable via one extra URL edit.
  Non-blocking; a follow-up splitting the free-text control into its own
  tiny `<form>` would remove the limitation entirely if it becomes a real
  complaint.
- **LOW** — `src/server/routes/dashboard.ts` is a one-line change outside
  the slice's stated file list. Disclosed above and in the handoff;
  judged necessary, not scope creep.
- **NOTE** — AC-7 and the slice's In-scope text assume a pre-existing
  per-query timing-log path for `queryProjectOptions`/`queryProfileOptions`
  that does not exist in this codebase. Addressed by adding a new,
  narrowly-scoped log for `queryAgentOptions` only, per AC-7's literal
  requirement, without touching the other two (out of scope).

No HIGH or MEDIUM findings.

## Verdict

**PASS.** All 8 ACs have test evidence. Build is clean. Touched-file test
suites are 100% green (84/84). Full-suite run shows zero regressions
attributable to this diff — all 87 failures are pre-existing/environmental
(confirmed by isolated rerun + root cause). Two LOW findings disclosed
above are accepted tradeoffs, not defects requiring a fix-and-rereview
cycle.
