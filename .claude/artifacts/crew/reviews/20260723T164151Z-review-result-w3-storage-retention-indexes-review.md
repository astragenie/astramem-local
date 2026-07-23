---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved
author_id: herolegion (branch w3/storage, worktree C:/work/mega/astra-wt/w3-storage)
judge_id: crew:reviewer
self_approval: false
---
# Review Result: Wave-3 storage+perf track (w3/storage)

- Created: 2026-07-23T16:41:51Z
- Reviewer: reviewer
- Decision: approved
- Status: completed
- Summary: PASS. Reviewed `git diff 3443efb1..w3/storage` (commits 8e55ab0b,
  72b28085, f91f2a91, c991f003, c2718578, 730209b1) in worktree
  `C:/work/mega/astra-wt/w3-storage`. The crux item — `pruneOldRecallServedEvents`'s
  DELETE predicate — is safe: independently re-read `listUnsynced`'s live SQL
  (src/sync/shipper.ts:220-241) and confirmed the widened predicate
  (`synced_at IS NOT NULL OR NOT EXISTS(memories row with scope IN
  ('team','org'))`) can never delete a row `listUnsynced` could still return.
  It is in fact slightly MORE conservative than the logical minimum (see Risk
  below) — that's a safety surplus, not a bug. Only `event_type='usefulness'
  AND family='recall_served'` rows are ever touched; no other family or
  event_type is reachable by the predicate. All three migration-059 indexes
  are confirmed used by EXPLAIN QUERY PLAN under a realistic data shape (see
  Test Adequacy). `chunkedIn`, the oversize-scanner N+1 fix, `MemoryRepo.getMany`,
  and the search.ts rerank-merge Map are all behavior-preserving, narrowly
  scoped changes. One non-blocking doc/log-accuracy finding below.
- Evidence Checked:
  - `src/sync/shipper.ts:220-241` (`listUnsynced`) read live, not assumed —
    for a `usefulness` event (never `erase_request`), its scope-gate reduces
    to exactly `synced_at IS NULL AND rejected_at IS NULL AND scope IN
    ('team','org')`, which is the exact case the prune's DELETE predicate
    excludes from deletion (plus it also spares already-`rejected_at`-set
    rows the prune's predicate doesn't need to spare — see Risk).
  - `migrations/059-recall-perf-indexes.sql` + `src/recall/pack.ts` — `, id
    DESC` tiebreaker present in both the index's trailing column and
    `selectPack`'s `ORDER BY` (pack.ts:~95).
  - `src/storage/sql-utils.ts` — `chunkedIn` + `CHUNK_IN_BATCH_SIZE = 900`,
    matching the pre-extraction batch size in usefulness.ts's
    `usefulnessScores`. Both `entities.ts` call sites
    (`memoryIdsForEntities`, `memoryIdsForEntitiesAsOf`) and
    `usefulnessScores` route through it unchanged otherwise.
  - `src/pipeline/oversize-scanner.ts` — `hasPendingOrRunningReembedJob`
    (per-candidate SELECT) replaced by `listActiveReembedMemoryIds` (one
    upfront `DISTINCT` query into a `Set`), same terminal-state semantics
    (`state NOT IN ('completed','poison')`).
  - `src/search/search.ts` — exactly one hunk changed: `results.find(r => r.id
    === hit.id)!` → `byId.get(hit.id)!` via a `Map` built once from the same
    `results` array. Output byte-identical under the pre-existing invariant
    that `results` carries unique ids (fusion output, not touched by this
    diff).
  - `src/mcp/server.ts` (`get_entity_timeline`) — `memRepo.get(mid)` N+1 →
    `memRepo.getMany(...)`; the `valid_to === null` / `since` filter / sort /
    slice / map chain afterward is untouched.
- Test Adequacy: Independently re-ran, not just trusted commit messages —
  `bunx tsc --noEmit -p tsconfig.json` and `-p tsconfig.tests.json`: 0 errors,
  both. `npx vitest run tests/storage tests/pipeline tests/recall tests/mcp
  tests/sync` = 59 files / 877 tests passed (author-claimed 775; the broader
  number here reflects the full directory set requested, not a discrepancy —
  zero failures either way). `npx vitest run tests/eval/retrieval-eval.test.ts`
  = 16/16 passed (ADR-005 floor holds). Additionally built a standalone
  `:memory:` DB against the built `dist/` (own PID, no `:7777`, no prod
  contact) seeded with a realistic shape (~20k `memory_events` rows, only the
  trailing ~2% unsynced — a steady-state sync-drain shape, not an
  all-unsynced fresh install) and ran `EXPLAIN QUERY PLAN` on all three
  target queries:
  - `selectPack` (both the branch-less and branch-filtered call shapes) →
    `SEARCH memories USING INDEX idx_memories_project_valid_created` for
    both, no `USE TEMP B-TREE`.
  - `listNeedingVecIndex` / `listOversizeNeedingVecIndex` → both
    `SCAN memories USING INDEX idx_memories_needs_vec_index`.
  - `shipper::listUnsynced` → `SCAN e USING INDEX idx_memory_events_unsynced`
    + `SEARCH m USING INDEX sqlite_autoindex_memories_1 (id=?) LEFT-JOIN`.
    (Note: under an unrealistic 75%-unsynced seed the planner correctly
    preferred a full scan instead — expected SQLite cost-based behavior when
    a partial index's filter isn't selective, not a defect in the index
    definition; re-seeding to a realistic low-unsynced-ratio shape confirmed
    the index is genuinely reachable.)
- Author: herolegion (branch w3/storage)
- Judge: crew:reviewer
- Risks:
  - 🟡 LOW, non-blocking: `src/pipeline/handlers/cleanup.ts` (~lines 130-134
    and the `console.log` at ~138) still says "Only already-synced rows
    older than the TTL are ever deleted" / logs "pruned N **synced**
    recall_served event(s)". This was accurate for 72b28085 but commit
    730209b1 widened the predicate (private-scoped/erased rows are now also
    pruned while `synced_at` is still NULL) and updated the top-of-file
    docblock and `config.ts`'s doc comment to match, but missed this one
    comment+log pair at the actual call site. Not a correctness bug — purely
    an operator-facing accuracy gap: someone reading cleanup logs today could
    wrongly conclude every pruned row had already shipped. Recommend a
    follow-up one-line fix (drop "synced" from the log message, update the
    stale comment) before/shortly after merge; does not block this PASS.
  - Also surfaced for the record (already lead-accepted per the task brief,
    not re-litigated here): the scope-mutability residual — a private atom's
    old `recall_served` rows can be pruned, then that atom promoted later,
    losing pre-promotion `recall_served` analytics history from the cloud's
    view. Documented in the function's own doc comment and the commit
    message; correctly scoped as ADR-010 measurement, not lifecycle data.
- Required Follow-up: Optional, non-blocking — fix the stale
  comment/log-message pair in `cleanup.ts` noted above so operator-facing
  logs describe the actual (widened) predicate.
