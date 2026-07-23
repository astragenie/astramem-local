# Review Result — Wave-6 selective post-rerank evidence bundling

- **Worktree:** `C:\work\mega\astra-wt\w6-evidence`
- **Branch:** `w6/evidence`
- **Reviewed commit:** `02dcd62a` (off `f2382da9`, feat/retrieval-overhaul tip)
- **Reviewer:** independent review agent (astramem-local session)
- **Verdict: PASS** (two non-blocking findings — see below; neither touches the
  two non-negotiable items)

## Scope

```
src/config/config.ts                             |  84 ++
src/config/writer.ts                             |  10 +
src/contracts/wire-hit.ts                        |   6 +
src/mcp/server.ts                                 |   7 +
src/search/evidence-bundle.ts (new)               | 271 ++
src/search/search.ts                              |  50 +/-
src/server/routes/search.ts                       |   9 +/-
tests/config/config.test.ts                       |  51 +
tests/config/writer.test.ts                       |   3 +
tests/search/evidence-bundle-integration.test.ts (new) | 227
tests/search/evidence-bundle.test.ts (new)        |  58
```
No unrelated changes — matches exactly the file list in the dispatch brief.

## 1. Flag-off byte-identical (non-negotiable) — VERIFIED

`git diff f2382da9..02dcd62a -- src/search/search.ts` shows the ONLY functional
change is at the two return sites:

```ts
return opts.evidenceBundling ? await applyEvidenceBundling(...) : finalHits;
...
return opts.evidenceBundling ? await applyEvidenceBundling(...) : results;
```

`opts.evidenceBundling` is `undefined` unless a caller resolves it via
`resolveEvidenceBundlingOpts(config)`, which itself returns `undefined` when
`config.evidenceBundling.enabled` is `false` (the shipped default in
`defaultConfig()`). Everything else in the diff is additive interface fields
(`bundled?`, `bundle_reason?` on `SearchHit`) or new imports — no reordering,
no new query, no score perturbation on the disabled path. Confirmed by:

- Reading the diff directly (shown above) rather than trusting the summary.
- `npx vitest run tests/eval tests/contracts` (ADR-005 recall/NDCG floors +
  CONTRACT-FREEZE conformance) at the flag's default — **287 passed, 1
  skipped, 17 files, 0 failed**. No retrieval-eval numbers moved.
- The builder's own integration test explicitly asserts
  `evidenceBundling: undefined` produces byte-identical ranked ids and scores
  (`toBeCloseTo(..., 6)`) vs. omitting the option entirely.

## 2. Scope-safety (non-negotiable) — VERIFIED for the listed dimensions

Read the actual SQL in `src/search/evidence-bundle.ts` rather than taking the
claim on faith. The candidate-gathering queries (`session_id IN (...)`,
`memory_entities` joins) are unfiltered — but the final row-fetch that
produces `extras` re-applies the IDENTICAL fragments `search()` built for the
base result set:

```ts
FROM memories WHERE id IN (${idPlaceholders}) AND ${sql.validityClause}${sql.whereFilter}
```
with params `...rankedIds, ...sql.validityParams, ...sql.filterParams` — same
placeholder order as `search()`'s own `sql` variable at `search.ts:1169-1170`.
`whereFilter`/`validityClause`/`filterParams`/`validityParams` are the exact
same local variables threaded from `search()`'s existing filter-building step
(not re-derived), so `type`/`scope`/`project`/`agent`(filter mode)/`since`
(via `filterClauses`→`whereFilter`) and `as_of`/current-snapshot validity (via
`validityClause`) can never be bypassed by an enrichment pull — a candidate
that fails any of those clauses is silently dropped from `rows` before
`extras` is built. There is only one filter-building call site in the file,
so no drift is possible by construction.

Confirmed by direct code reading, not just the doc comment's claim, and by
the passing `tests/eval`/`tests/contracts` suite plus the builder's own
"sameSession:false/sameEntity:false independently gate their own scoped pull"
test.

**Finding (informational, not blocking):** `filters.entity` narrowing is
applied earlier in `search()` (pre-fusion candidate intersection via
`applyEntityFilter`), not as part of `whereFilter`/`validityClause` — so it is
NOT reapplied by evidence-bundling. An `entity`-scoped call's enrichment pass
can surface atoms unrelated to the filtered entity. This dimension was
deliberately absent from the review brief's own list
(project/scope/type/agent/since/as_of/validity), and `entity` is a topic
narrowing, not a tenant/security boundary like `scope`/`project`, so I'm not
treating it as a scope-safety violation. But `evidence-bundle.ts`'s own doc
comment ("an enrichment pull can never surface an atom the base search's own
filters ... would have excluded") overclaims slightly against this one case —
worth a one-line comment carve-out or a follow-up ticket, not a merge blocker.

## 3. Wire contract unchanged — code correct, but missing the paired test

`src/contracts/wire-hit.ts` destructures `bundled`/`bundle_reason` into
discarded `_bundled`/`_bundleReason` bindings exactly like the existing
`evidence`/`correction_pending`/`reranked`/`rerank_score` strips — confirmed
directly in the diff. `npx vitest run tests/contracts` passes clean.

**Finding (should-fix, not blocking since the flag ships off):** this repo has
an established, explicit precedent — every prior LOCAL-ONLY `SearchHit` field
got its own dedicated `toWireHit` strip test run through the real ajv-compiled
schema (`tests/contracts/wire-hit.test.ts`'s `correction_pending` suite,
`tests/search/evidence-rerank.test.ts`'s `evidence` suite). This PR is the
first LOCAL-ONLY field addition that does NOT add that paired test — no
assertion anywhere exercises `toWireHit` against a hit carrying
`bundled`/`bundle_reason`. The code is correct today (verified by reading it),
but there's nothing in the suite that would catch a future accidental
un-stripping the way the existing `correction_pending`/`evidence` tests would.
Recommend adding a small mirror of `tests/contracts/wire-hit.test.ts`'s suite
before this ships with `enabled: true` in any environment.

## 4. No N+1 — VERIFIED

Every candidate-gathering query in `evidence-bundle.ts` goes through
`chunkedIn` (`src/storage/sql-utils.ts`, the 2026-07-15 incident-class
helper, batch size 900 — well under `SQLITE_MAX_VARIABLE_NUMBER`): anchor
session lookup, same-session pull, same-entity anchor→entity lookup, and
entity→memory pull are each ONE batched query (or a small constant number of
batches), never per-candidate.

## 5. Bounded — VERIFIED

- `maxExtra <= 0` short-circuits to `hits` unchanged (line 128).
- `rankedIds` is `.slice(0, opts.maxExtra)` after sorting by `sharedCount`
  desc + deterministic id tiebreak — a real cap, not advisory.
- `floorScore = Math.min(...hits.map(h => h.score)) * 0.5` — every bundled
  hit's score is this floor, strictly below the weakest anchor in the common
  case. (Minor theoretical edge not worth blocking: if the weakest anchor's
  real score were exactly `0`, `floorScore` would also be `0`, i.e. equal
  rather than strictly less — I did not find a realistic path to a `0`
  fused score given `usefulness` defaults to `0.5` and importance/freshness
  are typically nonzero, so this is a paper cut, not a live bug.)
- Base hits (`hits`) are never mutated — `[...hits, ...extras]` is pure
  append; the builder's own test explicitly locks in that both anchors keep
  their original slots regardless of the cap.

## 6. Governance — VERIFIED

`applyEvidenceBundlingGovernance` (mirrors `applyMultiHopGovernance`) clamps
`maxExtra`/`minDistinctSessions` via the shared `clampPositiveField` (requires
`Number.isInteger(value) && value > 0`, so `0`/`-1`/`NaN`/`2.5` all fall back
to the documented default) and falls back non-boolean `sameEntity`/
`sameSession` to their defaults. Wired into `applyAllGovernance`
(`src/config/config.ts:2908`), which both `loadConfig` paths already funnel
through post Wave-3's governance-unify (`src/config/loader.ts:327` and
`config.ts`'s `mergeAndGovern`-style wrapper both call `applyAllGovernance`,
confirmed via grep — no separate un-governed path exists). Covered by 6 new
test cases in `tests/config/config.test.ts` (`it.each([0, -1, NaN, 2.5])` for
both numeric fields, missing-block fallback, non-boolean fallback, and an
end-to-end `loadConfig` wiring check) — all pass.

## 7. Scope discipline / typecheck — VERIFIED

- `npx tsc -p . --noEmit` — clean.
- `npx tsc -p tsconfig.tests.json --noEmit` — clean.
- `npx tsc -p tsconfig.eval.json --noEmit` — clean.
- `npx vitest run tests/search/evidence-bundle.test.ts tests/search/evidence-bundle-integration.test.ts tests/config/config.test.ts tests/config/writer.test.ts` — **204 passed**.
- No changes outside the files the dispatch brief named.

## Conclusion

Both non-negotiable properties hold under direct code inspection (not just
the builder's summary): flag-off is structurally byte-identical, and every
scope dimension named in the review brief (project/scope/type/agent/since/
as_of/validity) is correctly re-enforced on the enrichment pull because it
reuses the exact same SQL fragments `search()` built, not a re-derivation.
Full relevant suite green (204 + 287/288), all three tsconfigs clean, no
scope creep.

Two non-blocking findings for the record:
1. **Should-fix before any `enabled: true` flip:** add a `bundled`/
   `bundle_reason` strip test to `tests/contracts/wire-hit.test.ts` mirroring
   the existing `correction_pending`/`evidence` pattern — the code is correct
   today but nothing pins it against regression.
2. **Informational:** `filters.entity` narrowing isn't reapplied by the
   enrichment pull (only project/scope/type/agent/since/as_of are) — not a
   tenant-security boundary, but the doc comment's "can never surface an atom
   the base search's own filters ... would have excluded" claim is slightly
   broader than the actual guarantee. Worth a comment caveat or follow-up.

**PASS — cleared for release as the dormant opt-in it's built to be.**
