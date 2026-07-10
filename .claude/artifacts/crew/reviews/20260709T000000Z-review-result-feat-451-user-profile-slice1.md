# Review Result — FEAT-451 Slice 1 (GET /profile + user_profile MCP tool)

**Branch:** feat/feat-451-user-profile
**Commit reviewed:** d2ae73a
**Worktree:** C:\work\mega\astramemory-local-worktrees\feat-451
**Spec:** docs/specs/FEAT-451-profile-design.md + .claude/artifacts/loop/backlog/triaged/FEAT-451.md
**Review type:** independent gate review (read + test-run only, no code changes)

## review_decision: PASS

## Scope reviewed

`git diff origin/main...HEAD` (10 files, 789 insertions):
README.md, contracts/manifests/mcp-tools.v1.json, src/mcp/server.ts, src/server/app.ts,
src/server/queries/user-profile.ts (new), src/server/routes/profile.ts (new),
tests/mcp/server.test.ts, tests/mcp/user-profile-conformance.test.ts (new),
tests/server/queries/user-profile-queries.test.ts (new), tests/smoke/mcp-stdio.e2e.test.ts.
No migrations/ files touched — confirms the "zero schema change" claim.

## Verification performed

1. **Rollup mapping vs design doc.** `src/server/queries/user-profile.ts:70-71` (`SOURCE_TYPES =
   ['fact','note','lesson','decision']`) and `KNOWN_ENTITY_KINDS = ['actor','tech','product','tool']`
   match design doc §1 exactly. `command`/`todo`/`event` correctly excluded (proven by
   `tests/server/queries/user-profile-queries.test.ts:66-86`).
2. **Live-computed, no cache/persistence.** No new table, no cache field, no rebuild job anywhere in
   the diff — every `buildUserProfile()` call is a fresh `db.prepare(...).all()`. Confirmed by
   reading the full new module; no memoization.
3. **Deterministic total-order ranking.** Scored sections: `usefulness DESC, importance DESC, id ASC`
   (`user-profile.ts:150-155`) — matches design doc §5 exactly, proven by the "ties -> id ASC"
   test (`user-profile-queries.test.ts:88-102`, explicit `usefulnessScores`-triggered tie exercise).
   The builder's *added* tie-breaks beyond the design doc's explicit scope (recent_decisions:
   `created_at DESC, id ASC`; known_entities: `mention_count DESC, name ASC`) are genuinely needed:
   the design doc's AC-6 requires byte-stable output for *any* ranked section, and `created_at`
   ties are realistic on bulk/backfilled inserts, `mention_count` ties are realistic with few
   entities. Both tie-breaks are correctly implemented (verified by reading the sort comparators
   and by the AC-6 conformance test at `tests/mcp/user-profile-conformance.test.ts:186-214`, which
   passes 5x-repeated `JSON.stringify` byte-identity against a fixture DB seeded with 5 explicitly
   tied facts).
4. **AC-3 lifecycle.** `activeClause()` (`valid_to IS NULL AND archived = 0`) is applied in every
   query (scored sections, recent_decisions, known_entities join, counts) — same predicate
   `agent-profile.ts` uses. `tests/server/queries/user-profile-queries.test.ts:146-159` inserts a
   fact + a superseded lesson pair and proves both drop out (`standing_facts` empty, only the
   successor lesson remains). Matches AC-3 verbatim.
5. **AC-4 authz.** `tests/mcp/user-profile-conformance.test.ts:153-163` proves: no Bearer -> 401
   `{"error":"unauthorized"}` (global preHandler, no route-local check, per `profile.ts`'s own
   header comment); unrecognized `?scope=bogus` -> 400 (not a silent default) via
   `isValidProfileScope()`; no per-scope 403 path exists anywhere in the route. Matches the
   corrected AC-4 in the design doc exactly.
6. **Performance sanity (EXPLAIN QUERY PLAN, ran against a migrated `:memory:` DB via the built
   `dist/`).** All five per-request queries (fact/note/lesson scored sections, decision counts,
   recent_decisions, known_entities join) plan as `SEARCH memories USING INDEX
   idx_memories_archival_candidates (archived=? AND valid_to=?)` — i.e. every query narrows via the
   existing `(archived, valid_to, created_at)` partial index, then filters `type`/`scope` **without
   an index** across that entire active-memory row set. This is a real difference from
   `agent-profile.ts`, which got a dedicated composite index
   (`idx_memories_agent(agent, valid_to, archived, type, created_at DESC)`, migration 019) precisely
   because the equivalent per-agent query regressed at ~20k-memories-per-agent scale. See
   **FINDING-1** below — not a blocker per the review brief's own "acceptable for v1" carve-out, but
   worth tracking.
7. **MCP shared-module pattern.** `mcp/server.ts`'s `user_profile` tool calls the identical
   `buildUserProfile(db, args.scope ?? 'private')` the REST route calls
   (`routes/profile.ts:29` vs `mcp/server.ts:589`). Conformance test
   (`user-profile-conformance.test.ts:132-151`, `:165-184`) strips only `generated_at` before
   `toEqual` — read the whole test file, confirmed that's the only stripped field and the only
   legitimate difference (build-time timestamp, two independent calls milliseconds apart).
8. **Tool-count sync (17->18).** Checked all four required locations: README.md prose table (new
   `user_profile` row) + Status section (`17-tool` -> `18-tool`), `tests/mcp/server.test.ts`
   (title + assertion + name list, both now 18/consistent — note: pre-existing test *title* said
   "16 tools" while the assertion checked 17, a pre-existing off-by-one in the title text that
   predates this branch; this branch incidentally fixes it to 18/18 consistent),
   `tests/smoke/mcp-stdio.e2e.test.ts` (comment + array), `contracts/manifests/mcp-tools.v1.json`
   (new tool entry). All four are updated and mutually consistent.
9. **Build + tests.** `bun run build` (tsc -p .) — clean, zero errors.
   `npx vitest run tests/server/queries/user-profile-queries.test.ts
   tests/mcp/user-profile-conformance.test.ts tests/mcp/server.test.ts
   tests/eval/retrieval-eval.test.ts` — **4 files, 75 tests, all passed**, including the ADR-005
   eval-gate floors (recall@10/NDCG@10) unaffected, confirming the profile path shares no code with
   `src/search/fuse.ts` as claimed. Did not run `tests/scripts/post-merge-rebuild.test.ts` per the
   review brief (known-fixed-on-main, expected-stale-fail in this pre-rebase worktree).

## Findings

**FINDING-1 [MEDIUM, non-blocking] — no dedicated index for the profile queries' filter shape;
rows are fetched uncapped (no SQL-side LIMIT) before JS-side sort+cap.**
`src/server/queries/user-profile.ts` — `queryScoredSection` (~line 140), `queryRecentDecisions`
(~line 175), `queryKnownEntities` (~line 200), `querySectionCounts` (~line 110).

Every profile-section query filters `type`/`scope` in SQL but the only index actually used is
`idx_memories_archival_candidates(archived, valid_to, created_at)` (verified via
`EXPLAIN QUERY PLAN` against the built daemon) — there is no index covering `type` (or `scope`), so
each of the 5 queries scans the *entire active-memory set across all types* to find its matches, and
（unlike `agent-profile.ts`'s `queryRecentDecisions`, which has `ORDER BY created_at DESC LIMIT ?`
in SQL） `queryScoredSection`/`queryRecentDecisions` here fetch **all** matching rows into JS
(deliberately, per the file's own comment, so `rowsRead` can feed AC-5's `atom_count_consumed`
before capping) and only slice to the section cap afterward. On a real, large local DB (the
CLAUDE.md-cited "70MB real DB" scale) this means a single `GET /profile` call does up to 5 passes
over the full active-memory row set, none of them SQL-capped. `agent-profile.ts`'s comparable query
got a dedicated migration (019/020) specifically because this class of query regressed at ~20k
memories. The design doc explicitly defers perf work until read volume is "measured to be a
problem" (§2 v2 discussion), so this is acceptable to ship for v1 as scoped — flagging so it's not
forgotten, not blocking this review.

**FINDING-2 [LOW, nit] — scope enum literal duplicated, not shared.**
`src/mcp/server.ts` (`z.enum(['private','team','org','all'])`, ~line 578) duplicates
`src/server/queries/user-profile.ts`'s `VALID_PROFILE_SCOPES` list, which is not exported. If a
scope value is ever added/removed, these two literals could silently drift. Low cost to fix: export
`VALID_PROFILE_SCOPES` (or `ProfileScope`) and derive the MCP `z.enum(...)` from it. Not blocking.

## Summary

Implementation matches `docs/specs/FEAT-451-profile-design.md` precisely on every decision point
(rollup mapping, live-computed/no-persistence, deterministic total ordering with a correctly
justified extra tie-break, AC-3 lifecycle exclusion, AC-4 honest single-Bearer authz with no
per-scope 403, shared-module REST/MCP parity, tool-count sync across all 4 required locations).
Build is clean, all new + adjacent test suites pass (75/75), and the ADR-005 eval-gate floors are
unaffected. Two non-blocking findings recorded above (query indexing/row-volume follow-up;
enum-literal DRY nit) — neither contradicts the design doc's own v1 scope decisions.
