# Review result — doctor canaries: auto-capture + usefulness-feedback-loop (2026-07-12 "wired, never fired" class)

**Reviewer:** independent review agent (read-only)
**Scope:** uncommitted working-tree changes in `C:\work\mega\astramemory-local` (main checkout, branch `main`)
**Decision:** **approved_with_notes**

## Files reviewed

- `src/doctor/checks.ts` (modified) — new `checkUsefulnessFeedbackLoop`, hardened `checkAutoCapture`
- `src/storage/usefulness.ts` (modified) — new `feedbackLoopSummary()`
- `tests/doctor/auto-capture-check.test.ts` (modified)
- `tests/doctor/usefulness-feedback-loop-check.test.ts` (new)
- `tests/e2e/usefulness-feedback-loop.e2e.test.ts` (new)

## Verification performed

- Read the full diff and all four test/source files.
- Ran the three affected test files directly: **16/16 pass** (`tests/doctor/usefulness-feedback-loop-check.test.ts`, `tests/doctor/auto-capture-check.test.ts`, `tests/e2e/usefulness-feedback-loop.e2e.test.ts`), confirming the author's claimed 14 doctor + 2 e2e count.
- Confirmed `checkUsefulnessFeedbackLoop` is registered in `coreChecks()` (`src/doctor/checks.ts:1289`) — it genuinely runs on every `doctor` invocation, not a dead registration.
- Traced `submit_feedback`/`mark_memory_used` (`src/mcp/server.ts:778-816`) → `recordRecallUsed`, and `invalidate()`/`supersede()` (`src/storage/memory-events.ts:218-240`, `:272-318`) → both the lifecycle event AND a same-transaction `usefulness`/`memory_corrected` append. The e2e test's line citations for these are accurate.
- Confirmed `queryScoredSection` (`src/server/queries/user-profile.ts:148-181`) sorts `usefulness DESC, importance DESC, id ASC` — the e2e test's ordering assertions genuinely exercise this real ranking path, not a coincidence of some other tiebreak.
- **Empirically checked the query plan** for `feedbackLoopSummary()` against a fully-migrated in-memory DB via `EXPLAIN QUERY PLAN` (see finding 1 below) — this was not just static reasoning, I ran it.

## Findings

**[MEDIUM] `src/storage/usefulness.ts:243-253` (`feedbackLoopSummary`) — full table scan of `memory_events`, not index-backed, reintroduces the exact perf shape migration 019 was written to eliminate.**

I ran `EXPLAIN QUERY PLAN` on the actual query against a migrated schema:

```
--- feedbackLoopSummary query plan ---
USE TEMP B-TREE FOR count(DISTINCT)   x3
SCAN memory_events                     <-- full table scan, ALL event types, not just 'usefulness'

--- usefulnessRate "served" query (sibling function, for comparison) ---
SEARCH memory_events USING INDEX idx_memory_events_usefulness_served (created_at>?)
```

The three existing partial indexes from migration 019/021/025 (`idx_memory_events_usefulness_served`, `idx_memory_events_usefulness_used`) are keyed on `(created_at, atom_id) WHERE event_type='usefulness' AND family=<literal>` — they only help when the family check is a literal in the **WHERE clause**. `feedbackLoopSummary` instead puts the family check inside `CASE` expressions in the **SELECT list**, with only `WHERE event_type = 'usefulness'` as the filter. No index covers a bare `event_type = 'usefulness'` predicate (the only `event_type`-only index, `idx_memory_events_correction_type`, is a partial index restricted to `event_type IN ('invalidate', 'supersede')` — doesn't apply here). The result is `SCAN memory_events`: every event of every type ever logged (ingest, distill, archive, restore, unpurge, `invalidate`/`supersede` raw events, etc.), not just usefulness rows.

Migration 019's own commit message measured this exact query shape at **21ms → 1179ms p50 from 1k → 100k rows** before it was fixed for `usefulnessRate()`. `feedbackLoopSummary()` is all-time and unbounded (no `created_at` floor, unlike `usefulnessRate`), so on a store that's already at 12,386 memories in production, `memory_events` is plausibly well past the row count where this becomes seconds, not milliseconds — and it only gets worse as the store ages, on every single `doctor` run.

Fix: split into three per-family queries mirroring `usefulnessRate`'s/`usefulnessByType`'s existing pattern (`WHERE event_type='usefulness' AND json_extract(payload_json,'$.family')='recall_served'`, etc.) so `served`/`used` ride the existing partial indexes. `memory_corrected` still has no partial index (only 019/021/025 covers served/used) — either add one (mirrors migration 019 exactly) or accept it unindexed since correction volume is presumably far lower than recall-served volume.

**[MEDIUM] `checkUsefulnessFeedbackLoop` (`src/doctor/checks.ts:497-559`) calls `buildMemoryHealthFull()` for a single field it needs, paying for two extra O(N) scans it never uses.**

The check only reads `report.activeCount`. `buildMemoryHealthFull()` is the "full tier" (`src/server/queries/memory-health.ts:271-278`) that adds `countsByTypeAndScope()` (two GROUP BY scans of active memories, byType + byScope) and `stalenessDistribution()` (a full scan reading every active row's `valid_from`/`created_at`) on top of the cheap tier — explicitly documented in that file as "acceptable off the /health hot path only," but that comment predates this check calling it a second time per `doctor` run purely for a count. `buildMemoryHealthCheap()` (`memory-health.ts:181-193`) already returns `activeCount` via an index-backed `COUNT(*)` (`countActiveAndArchived`) and is exactly what's needed here. `checkMemoryHealth` (the existing check right above this one) already pays for the full tier once per `doctor` run for its own reporting purposes — this new check adds a second, redundant full-tier computation (plus a second DB connection open) just to read one integer that the cheap tier already provides directly.

Fix: use `buildMemoryHealthCheap(db)` instead of `buildMemoryHealthFull(db)` in `checkUsefulnessFeedbackLoop`.

**[LOW/NOTE] All-time, unbounded `hasSignal` check has a permanent-silence blind spot to regression.**

`hasSignal = summary.usedDistinct > 0 || summary.correctedDistinct > 0` is all-time with no window. Once a single `recall_used`/`memory_corrected` event has ever been recorded — even once, even long ago — the canary goes permanently silent for that install forever, even if the invocation site that produced it later regresses (e.g., a client-side wiring change removes the only caller of `submit_feedback`). The existing `checkUsefulness` (7d-windowed) sits right next to it but is purely informational (`ok: true` always) and never elevates a regression to a WARN either. So the pair, together, cannot detect "worked once, then broke" — only "never worked, ever." This is a real gap in regression coverage, but it's a reasonable v1 scope boundary given the stated goal (closing the "never once" hole found in production) rather than a defect in what's shipped here. Flagging for awareness, not blocking.

**[INFO, not a blocker] Pre-existing stale doc comment adjacent to this diff.** `src/mcp/server.ts:799-800`'s `submit_feedback` tool description says "v1: feeds the recall-usefulness rate on doctor/dashboard/health only, does not affect ranking" — but per `CLAUDE.md`'s "Formerly-deferred items" section and the e2e test in this very diff, ADR-010's v1.x epsilon component is live in ranking (`fuse.ts`) and the e2e test explicitly proves `submit_feedback` reorders `standing_facts`. This line is outside the diff under review (not touched by this change) so it's out of scope to fix here, but worth a follow-up ticket since a reader of that tool description today would be misled about current behavior.

## Answers to the specific scrutiny requested

1. **False-positive risk** — Verified via the test suite: fresh/no-DB install stays silent (`no DB yet`); a "remember-only, never searches" user stays silent because `servedDistinct` never crosses the floor even if `activeCount` does (both floors are required, correctly AND'd); a read-heavy user who searches but never gives explicit feedback WILL eventually WARN and stay WARNing — but per the team-lead's own framing this is the intended, permanent nag until the client-side invocation gap is actually closed (matches the real production bug), not a false alarm. This holds up.
2. **`feedbackLoopSummary()` correctness/efficiency** — distinct-atom counting logic is correct (three `COUNT(DISTINCT CASE...)` in one pass, same encrypted-DB path as every other check via `openProductionDbReadonly`). Efficiency is the real issue — see MEDIUM finding 1 above, empirically confirmed with `EXPLAIN QUERY PLAN`.
3. **E2E test honesty** — confirmed real: only the `EmbedProvider` is mocked (repo convention), `remember`/`search_memory`/`submit_feedback`/`invalidate_memory` all go through the real Fastify app + real SQLite + real MCP dispatch. The recall-only regression guard (search must not move the score) is real and correctly aimed — `search_memory` only appends `recall_served` events, and `usefulnessScores()` never reads that family.
4. **Correction-via-`usefulnessScores()` test design** — legitimate given the architecture, not papering over a gap. Verified `invalidate()`/`supersede()` retire the atom (`valid_to` set) in the same transaction that appends the correction signal, and `queryScoredSection`'s `activeClause()` filters `valid_to IS NULL` — so a corrected atom genuinely has no active surface left to assert against. Asserting via the real `usefulnessScores()` function directly (not a mock) is the only way to observe the signal landed.
5. **Doctor registration** — confirmed wired into `coreChecks()` at `src/doctor/checks.ts:1289` and confirmed it actually executes via a direct test run.

## Recommendation

Approve with the two MEDIUM efficiency findings addressed before or shortly after merge — neither is a correctness bug (tests are honest and pass), but `feedbackLoopSummary()`'s full-table-scan shape is a known, previously-fixed-once perf regression pattern in this exact codebase, and will get worse silently as production stores age. Given this PR's whole thesis is "canaries should catch problems before they become invisible," shipping a canary that itself carries a resurrected version of a fixed perf bug is worth a fast follow-up rather than blocking merge outright.
