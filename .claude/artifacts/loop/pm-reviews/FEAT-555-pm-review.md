---
id: PM-REVIEW-FEAT-555
feature: FEAT-555
reviewed_at: 2026-11-06
pm_customer_impact: 0.5
pm_effort_estimate: 0.4
pm_strategic_alignment: 0.35
pm_technical_risk: 0.45
pm_dependency_depth: 0.05
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-555

## Demand Assessment

- **Evidence:** Operator's own write-back names this exact follow-up: docs/memory.md:181 — 'Still a 25-row activity window (LIMIT 25) — paging the full filtered history is a follow-up.' — closing the FEAT-554/SLICE-448 DONE note (docs/memory.md:177-181, released 0.22.1+0b96eb9e). The gap is quantified in the same entry (docs/memory.md:172): memories.agent holds 1,180 crew:reviewer rows, of which queryRecentMemories (src/server/queries/dashboard.ts:263, hard LIMIT 25 at :308) can surface at most 25. Frequency: every use of the agent/project/profile dropdowns FEAT-554 just shipped, i.e. the primary path of a brand-new feature. Workaround is real but inferior — the Search tab and recall --agent filters already reach the full history (filters.agent, FEAT-423/424), which is what caps customer_impact at 0.5 rather than higher.

## Scope Challenge

- **Scope notes:** SMALLEST DELIVERABLE: move the 15-row window from a JS slice to SQL. queryRecentMemories grows (limit, offset) params, a sibling count query reuses the same conditions/params composition (src/server/queries/dashboard.ts:264-300), and renderActivityFeed stops calling rows.slice() (src/server/routes/dashboard-html.ts:566-580). Keyset paging is NOT needed for the deep-page target (?page=50 = offset 735) and would complicate the caption; recommend LIMIT/OFFSET and cut keyset. WOULD CUT IF HALVED: the exact 'showing X-Y of Z' caption (page N/M alone is shippable); keep offset paging. NO OVERLAP: nothing else pages this feed; FEAT-554 (done) added the agent filter only.

TWO DECISIONS AN OPERATOR MUST SETTLE BEFORE AN UNATTENDED BUILDER STARTS — this is why autonomousSafe is false, not a decline:
(1) THE FEAT'S OWN PERF AC IS UNACHIEVABLE AS WRITTEN. It asks for 'p95 render under 150 ms on the 120k store' while excluding new indexes/migrations. No index on memories leads with created_at (verified over all of migrations/: the full set is idx_memories_agent, _archival_candidates, _capture_source, _consent_disclosed, _repo_type, _session, _speaker_label, _purge_batch, _project_valid_created, _needs_vec_index, _evidence_turn), so ORDER BY created_at DESC plus a filtered COUNT are unindexed scans of 120k rows, and the profile filter's correlated transcripts subquery (src/server/queries/dashboard.ts:276-290) must be evaluated per candidate row for the COUNT. Independently, the whole page already cold-renders in ~7.9s at 16k memories (documented at src/server/routes/dashboard-html.ts:628-633), so a 150 ms WHOLE-RENDER budget fails on arrival regardless of this change. AC-5 restates it as a feed-query-scoped budget with EXPLAIN QUERY PLAN evidence and an explicit FAIL-with-evidence path; confirm that restatement or lift the index exclusion.
(2) JOB-ROW SEMANTICS CHANGE OBSERVABLE BEHAVIOUR. Today buildActivityRows merges up to 10 queryRecentFailedJobs rows (src/server/queries/dashboard.ts:412) into the memory pool and sorts by timestamp, so a job row can legitimately land on page 2. The FEAT's 'job-failure rows only on page 1' pins them instead, which shifts every memory offset on page 1 and makes 'of Z' ambiguous (memories only, or memories plus jobs?). AC-7 resolves it as: jobs on page 1 only, Z counts memories, job count stated separately. Confirm or override.

FEAT BODY CLAIM TO CORRECT: 'existing project/profile/agent filter tests unchanged' holds for the filter assertions (tests/server/dashboard-html.test.ts:470 and :543 keep passing), but the five pagination tests at tests/server/dashboard-html.test.ts:264-312 WILL be rewritten — they feed baseData({ recentMemories: manyMemories(20) }) straight to renderDashboard and exercise no SQL at all (their own comment: 'in-memory slice over the already-fetched rows (no new SQL)'). Budget for that rewrite.

WEAK DIMENSIONS (last 5 grades, .claude/artifacts/loop/loop-snapshot.md): production_readiness 0.34, product_completeness 0.35, observability 0.48, reliability 0.51, architecture_quality 0.53 — all under 0.80. security 0.82 and test_confidence 0.86 are NOT weak this window (they were in FEAT-554's read; the averages moved after the FEAT-553/554 wave grades landed). One AC per weak dimension: AC-1/AC-7 product_completeness, AC-2 architecture_quality, AC-3/AC-4 reliability, AC-5 production_readiness, AC-6 observability.

COST ANALOG: SLICE-448 (FEAT-554) is the direct precedent — same two source files, same two test files. Actual $13.47 / 36.25M tokens / 56 min (.claude/artifacts/crew/cost/ feat554-slice448 report) against a predicted 3 points, and it still needed two fix rounds. Effort 0.4 (5 points) is a deliberate one-band bump over that analog for the SQL-shape change, the count query and the fixture rewrite — not a vibe. 5 points is under the 8-point decomposition gate, so no proposedSlices.

## Scores

- customer_impact: 0.50
- effort_estimate: 0.40
- strategic_alignment: 0.35
- technical_risk: 0.45
- dependency_depth: 0.05

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: P2, autonomousSafe false: operator-authored follow-up explicitly parked at docs/memory.md:181 with a quantified gap (25 of 1,180 agent-filtered rows reachable) but a tolerable Search/recall workaround, so customer_impact 0.5 and strategic_alignment 0.35 — dashboard operability supports the local-first memory-daemon mission without being its retrieval-quality centerpiece. technical_risk 0.45 sits at the top of the 0.3-0.5 band deliberately: one module, no contract or schema change and a clean git revert keep it out of the 0.6+ band, but verified-absent created_at index coverage plus the profile filter's per-row correlated subquery make an added COUNT a genuine event-loop hazard on a synchronous better-sqlite3 render path. effort 0.4 maps to 5 points (under the 8-point gate, no decomposition) and bumps one band above the SLICE-448 analog that actually cost $13.47 / 36.25M tokens / 56 min at a predicted 3 points and still took two fix rounds. autonomousSafe is false for two settle-first items, not for AC vagueness: the FEAT's own 150 ms whole-render AC is unachievable alongside its no-new-indexes exclusion on a page already cold-rendering ~7.9s at 16k rows, and pinning job-failure rows to page 1 changes shipped merge-and-sort behaviour and the meaning of 'of Z'. ACs 1-8 resolve both under stated assumptions, so the slice is dispatch-ready the moment an operator confirms them.

## Risks

- PRE-MORTEM Q1 (most likely review/validation failure in two weeks): an off-by-one between the SQL OFFSET and the caption. offset = (page-1)*15 must agree with 'showing 736-750 of 1180' at page 50 and with totalPages = ceil(1180/15) = 79. The clamp currently derives its total from rows.length inside the renderer (src/server/routes/dashboard-html.ts:527, :537, :570), so the moment the total comes from a separate COUNT the two can disagree silently — nothing fails loudly, the operator just sees a wrong caption or a skipped row at each page boundary.
- PRE-MORTEM Q2 (merged and broke the daemon — what does rollback actually require): git revert only. Two source files plus two test files, no migration, no schema or wire-contract change, no published artifact. The blast radius that is NOT revert-cheap is operational: better-sqlite3 is synchronous, so an unindexed COUNT added to the render path blocks the event loop and starves /health, which is the exact 2026-07-13 wedge-then-watchdog-kill restart loop documented at src/server/routes/dashboard-html.ts:628-645. A bad merge degrades the whole daemon, not just /dashboard — which is what AC-6's slow-query log and AC-5's isolated measurement exist to catch before that.
- PRE-MORTEM Q3 (which existing test would NOT catch a regression): none of the five pagination tests at tests/server/dashboard-html.test.ts:264-312 would. Every one builds recentMemories as a 20-element JS array via manyMemories() and asserts on renderDashboard output, so a wrong LIMIT, a wrong OFFSET, a wrong COUNT WHERE clause, or a count/page disagreement all stay green. The only DB-backed coverage is tests/server/queries/dashboard-queries.test.ts:232-376, which never asserts anything about row counts or windows. AC-8 closes exactly this gap.
- REPEAT-LESSON RISK, quoted from the direct predecessor's grade (.claude/artifacts/loop/grades/20261106T033206Z-feat554-slice448-grade.md): 'A real functional bug shipped past unit tests and the first self-review... 84/84 green tests gave false confidence; the defect was only found once something reproduced the actual two-field submission'. The same failure shape is available here: fixture-level pagination tests pass while the real SQL window is wrong. That slice graded test_confidence 0.55 and reliability 0.60 after two fix rounds. The verifier must drive a real DB at two different offsets, not a fixture array.
- PERF LANDMINE, established by inspection not by benchmark: the profile filter is the worst case. Its correlated subquery against transcripts (src/server/queries/dashboard.ts:276-290) is evaluated per candidate row, and a filtered COUNT(*) has no LIMIT to stop it early, so ?profile=X on a 120k store becomes an unbounded per-row subquery scan. The existing LIMIT 25 masks this today by stopping after 25 matches. This is the single most likely way the slice misses AC-5 while agent-only and project-only filters pass.
- SCOPE-CONTRADICTION RISK: the FEAT excludes new indexes while demanding a 150 ms budget that likely needs one (see scopeNotes decision 1). An unattended builder facing this either fabricates the perf evidence or silently adds a migration outside stated scope. Both are worse than a FAIL with EXPLAIN QUERY PLAN output, which is what AC-5 mandates.
- INJECTION CHECK: none found. The FEAT-555 body (.claude/artifacts/loop/backlog/pending/FEAT-555.md) contains no embedded imperative attempting to steer scoring, priority or autonomous_safe; it is an ordinary scope/acceptance description. Nothing to quote.
