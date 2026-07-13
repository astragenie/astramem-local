---
slice: SLICE-429
feature: FEAT-481
reviewer: independent-correctness-review (team-lead dispatch)
branch: feat/feat-481-slice429
commit_reviewed: 676e948
worktree: C:\work\mega\astramemory-local\.claude\worktrees\agent-a362a9019d927494e
date: 2026-07-13
verdict: PASS
---

# SLICE-429 correctness review — get_entity_related / get_entity_timeline / manifest owner flip

## Scope of diff (vs main)

Exactly 5 files, matching SLICE-3's stated scope, no scope creep:
- `contracts/manifests/mcp-tools.v1.json` (owner flip, 4 lines)
- `src/mcp/server.ts` (+161, both tool registrations)
- `tests/mcp/entity-relations-conformance.test.ts` (new, 330 lines, 13 tests)
- `tests/mcp/server.test.ts` (hardcoded tool count 18→20)
- `tests/smoke/mcp-stdio.e2e.test.ts` (hardcoded tool list, +2 names)

SLICE-1 (migration 027 + `EntityRelationRepo`, commit c99a651) and SLICE-427
close-ceremony (c882e9d) predate this commit and are out of this review's
scope per the dispatch.

## Test evidence

```
bunx vitest run tests/mcp/entity-relations-conformance.test.ts tests/contracts/mcp-tool-manifest-parity.test.ts
  Test Files  2 passed (2)
  Tests  19 passed (19)      # 13 conformance + 6 parity — builder's "13 tests" claim confirmed real, not a stub

bunx tsc --noEmit -p .
  (clean, no output)

bunx vitest run   (full suite)
  Test Files  242 passed (242)
  Tests  2887 passed | 6 skipped (2893)
```

No failures anywhere in the full suite — no regressions.

## AC-9 (get_entity_related)

Verified field-for-field against `C:\work\mega\memory\src\AstraMemory.Mcp\Tools\EntityTools.cs:67-143`:
output shape `{ id, subject_entity_id, predicate, object_entity_id, evidence_memory_id, source_excerpt, confidence, valid_from, valid_to }` matches byte-for-byte (`src/mcp/server.ts:670-680`). Zero client-side mapping needed.

- **direction filter**: `subject`/`object`/`both` semantics tested and correct (conformance test "direction filter: subject/object restrict to the matching role, both (default) returns either").
- **limit clamp**: schema is `z.number().int().positive().max(500).default(50)` — this **rejects** limit>500 (400-equivalent isError) rather than cloud's `Math.Clamp` silent-clamp-to-500. A deliberate, self-consistent, fail-loud choice (test explicitly asserts rejection, not clamping) — AC-9's literal wording ("max 500") is compatible with either interpretation. Not a defect, but note this is a **behavioral deviation from cloud** (cloud never errors on an oversized limit, it silently clamps) — worth a one-line comment for future readers, non-blocking.
- **asOf actually flows through**: confirmed end-to-end — `server.ts` calls `parseAsOf(args.asOf)` then passes it into `relationRepo.getForEntity(..., { asOf, limit, direction })`; not ignored. The "asOf excludes a relation once it passes its evidence memory's own valid_to" test exercises this live over real SQLite.

## CRITICAL — §4.1 validity-contract conformance

Confirmed the **tool path calls the repo's JOIN methods**, not a hand-rolled query: `server.ts:661-662` does `new EntityRelationRepo(db)` → `relationRepo.getForEntity(...)`, which dispatches to `getForSubject`/`getForObject`/the combined branch (`src/storage/entity-relations.ts:141-176`), every one of which does `JOIN memories m ON m.id = er.evidence_memory_id` plus the `MAX/MIN`-with-+inf-sentinel `VALIDITY_PREDICATE` (lines 82-86) — this is the real design-doc-§4.1 JOIN, not a stub.

The conformance test is real, not asserting against an empty store: `entity-relations-conformance.test.ts:164-193` seeds a relation, asserts it's visible with `asOf` one month later (`toHaveLength(1)`, non-empty baseline), then calls `events.invalidate(memId)`, explicitly asserts `entity_relations.valid_to` itself stays `NULL` (proving the exclusion can't come from that column), then re-queries with `asOf` = invalidated memory's own `valid_to + 10s` and asserts `toHaveLength(0)`. This is a genuine positive→negative transition test of the exact contract the design doc calls CRITICAL/[HIGH], not a trivially-passing assertion on an empty table.

## AC-10 (get_entity_timeline)

- Newest-first: tested and correct (`sort((a,b) => b.created_at - a.created_at)`).
- `since` is epoch-ms, not cloud's ISO-8601 — this is the one **dispatch-authorized** documented deviation, and it does match `search_memory`'s own `since: z.number()` convention (`server.ts:143-146`) exactly, as claimed.
- Reuses `EntityRepo.memoryIdsForEntities` — confirmed, no new SQL added; the "currently valid" / sort / `since` filtering happens in JS over the existing primitive's result set (`server.ts:729-740`), matching AC-10's "no new time-tracking machinery" requirement.

## AC-11 (manifest flip)

Confirmed same commit (676e948) touches both `contracts/manifests/mcp-tools.v1.json` (both entries `cloud`→`both`) and `src/mcp/server.ts` (tool registration). The parity test (`tests/contracts/mcp-tool-manifest-parity.test.ts`) is a real diff — it calls a live `tools/list` JSON-RPC request against an in-process `McpServer` and cross-checks names both directions (`local/both manifest names equal the registered tool set exactly (no drift either direction)`), not a hardcoded list. Ran green.

## Two flagged builder deviations

1. **`direction=both` combined-query semantics [MEDIUM, non-blocking]**: cloud's `EntityRelated` (`EntityTools.cs:108-140`) issues **two separate queries** (`GetForSubjectAsync` + `GetForObjectAsync`), each independently capped at `limit`, then concatenates — so `direction=both, limit=50` can return up to **100** rows from cloud, ordered subject-block-then-object-block. Local's `EntityRelationRepo.getForEntity` (`entity-relations.ts:155-176`) issues **one combined query** (`OR` on subject/object) with a **single global `LIMIT`** — so the same call returns at most **50** rows total, globally sorted by `valid_from DESC` across both directions. This is a real behavioral divergence from cloud (not just a formatting difference) and, unlike the `since`-epoch-ms deviation, it is **not documented anywhere** — no code comment, no commit-message callout, no conformance test exercises `direction=both` together with a `limit` small enough to expose the difference (the one `both`-mode test seeds only 1 relation per role). Recommend: add a one-line comment on `getForEntity`'s combined branch noting this is an intentional divergence from cloud's per-role-limit concat (arguably the more sensible reading of "limit" as a cap on total rows returned) — documentation-only, not a code fix, and not blocking this slice.
2. **`entityId`, not name, resolution [ACCEPTABLE, documented]**: both tools take a raw entity id, mirroring `GET /entities/:id/memories` rather than `search_memory`'s name+normalize-seam `entity` filter. This is explicitly called out in the commit message with rationale, matches AC-9/AC-10's own literal wording (both ACs say "entityId"), and is internally consistent with the closest existing precedent in this codebase. No concern.

## Verdict: PASS

All three ACs (AC-9, AC-10, AC-11) verified with real, passing evidence — not claimed-but-unverified. The CRITICAL §4.1 validity-JOIN contract is genuinely implemented and genuinely tested end-to-end through the MCP tool surface, not just at the repo-unit level. No scope creep. One MEDIUM non-blocking documentation gap (direction=both limit semantics) recommended as a fast follow, not a merge blocker.
