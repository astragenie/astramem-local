---
feat: FEAT-454
branch: feat/feat-454-retrieval-presets
commit: d995208
base: origin/main
review_decision: PASS
reviewer: crew-reviewer (independent gate)
---

# FEAT-454 — Named retrieval presets — review result

## Scope reviewed
`git diff origin/main...HEAD` — exactly 9 files, +708/-8, as expected:
`README.md`, `docs/recall-filters.md`, `docs/retrieval-presets.md`,
`src/mcp/server.ts`, `src/search/presets.ts`, `src/server/routes/search.ts`,
`tests/eval/retrieval-eval.test.ts`, `tests/mcp/preset-parity.test.ts`,
`tests/search/presets.test.ts`.

**Contamination caveat:** the worktree's working tree carries 6 unstaged
FEAT-452 files (rerank.ts, search.ts, provenance.ts + tests/docs) unrelated
to this commit. I diffed those 6 files for any `preset`/`entity`/`as_of`
overlap and found none of substance (one incidental `EntityRepo` import line
in provenance.ts, unrelated to preset routing). Targeted tests were run live
against the contaminated tree and all passed — noted as corroborating, not
load-bearing, since the commit itself is clean.

## Findings

No blocking or non-blocking issues found.

## Verification against the review checklist

1. **`preset` enum + surfaces** — `RETRIEVAL_PRESETS = ['default','recent','exact','entity','temporal']`
   (`src/search/presets.ts:39-40`) wired into GET /search, POST /recall
   (`src/server/routes/search.ts:172-188, 233-242`) and MCP `search_memory`/
   `recall_memory` (`src/mcp/server.ts:143-153,173-185, 246-256,276-288`).
   `entity`/`temporal` without their required filter → 400 / `isError`
   (`validatePresetFilters`, `src/search/presets.ts:83-103`), verified live in
   `tests/mcp/preset-parity.test.ts` (both AC-3 cases, both REST 400 cases,
   both MCP `isError` cases, both surfaces via `describe.each`). No touch of
   `contracts/` — confirmed via `git diff origin/main...HEAD --stat -- contracts/`
   (empty) and a full-diff grep for `mode` (no hits) — the live cloud `mode`
   field is untouched.

2. **HARD AC — default byte-identical** — `tests/eval/retrieval-eval.test.ts:167-203`
   is a real assertion, not a tautology. It runs the ADR-005 eval harness twice
   against two independently-migrated in-memory DBs: once with the raw
   pre-FEAT-454 shape (`defaultConfig().search` fed directly, no preset
   concept invoked at all) and once with `resolvePresetWeights('default',
   defaultConfig().search)` (the actual code path every route now uses),
   asserting `rankedAtomIds`, `meanRecall`, `meanNdcg` are identical. Since
   one side never touches the new preset code, this pins the real weight
   vector rather than comparing the new code against itself. A second test
   asserts `resolvePresetWeights('default', base)` structurally equals `base`
   (`toEqual`). Confirmed by inspecting `resolvePresetWeights`
   (`src/search/presets.ts:65-76`): the `default` branch is
   `applyFusionGovernance({ ...base })` — a spread + no-op governance pass on
   already-governed input, not independent logic.

3. **Governance** — every branch of `resolvePresetWeights` funnels through
   `applyFusionGovernance` (`src/config/config.ts:334`), including `default`/
   `entity`/`temporal` (`src/search/presets.ts:65-76`). `recent`/`exact` scale
   the CALLER's own resolved `delta`/`alpha` by a named multiplier constant
   (`RECENT_FRESHNESS_MULTIPLIER = 4`, `EXACT_BM25_MULTIPLIER = 2`) rather than
   substituting a hand-rolled absolute weight — confirmed no literal weight
   vector bypasses the ceiling. Unit test
   `tests/search/presets.test.ts` ("AC-2: a scaled preset that would exceed
   the component ceiling is clamped") verifies the clamp fires
   (0.9×2=1.8 → clamped to 1.0), and a second test verifies every preset
   forces `eta=0` when eta is configured without recorded eval evidence —
   i.e. the η eval-evidence guard inside `applyFusionGovernance` is not
   bypassed by any preset branch either.

4. **Per-request weights, no shared-state mutation** — `baseWeights = cfg.search`
   is read once per route-factory call (unchanged from before this FEAT — a
   rename from `weights`, confirmed via diff), but `resolvePresetWeights` is
   now called per-request/per-tool-call and always returns a **new** object:
   `applyFusionGovernance` does `{ ...search }` internally
   (`src/config/config.ts:345`) and only mutates the local copy's clamped
   keys, never the object passed in; `resolvePresetWeights`'s own `recent`/
   `exact` branches also spread (`{ ...base, delta: ... }`) before calling
   governance. `baseWeights` itself is never assigned into. No cross-request
   mutation of the shared config object.

5. **MCP parity** — `tests/mcp/preset-parity.test.ts` runs both `search_memory`
   and `recall_memory` through `describe.each` for every preset-routing
   scenario (recent/exact acceptance, entity/temporal 400/isError and success
   cases, out-of-enum rejection) plus dedicated REST-vs-MCP-adjacent AC-1
   ordering checks. Real Fastify server + real `/mcp` Streamable HTTP
   transport, no internal reach-in — same harness pattern as the existing
   `tests/mcp/search-parity.test.ts`.

6. **Test run** — `bun run build` clean (tsc -p ., no errors). Targeted
   suites: `bunx vitest run tests/search/presets.test.ts
   tests/mcp/preset-parity.test.ts tests/eval/retrieval-eval.test.ts` → **3
   files, 46 tests, all passed**, 1.64s. Did not run
   `tests/scripts/post-merge-rebuild.test.ts` (known pre-existing unrelated
   failure per instructions).

## Minor observations (non-blocking, not filed as findings)
- `resolvePresetWeights`'s switch has no `default:` case and relies on
  TypeScript exhaustiveness over the `RetrievalPreset` union for
  completeness; safe today since the route/MCP layers zod-validate the enum
  before calling it, but a compile error (rather than a runtime throw) is the
  only guard against an un-mapped future preset value.
- `docs/retrieval-presets.md` is new (84 lines) and README/`docs/recall-filters.md`
  cross-link it correctly.

## Verdict

**PASS.** All ACs (AC-1 byte-identical default, AC-2 governance-only weight
construction, AC-3 deliberate 400-on-missing-filter for entity/temporal) are
implemented and covered by non-tautological tests. No contract/shared-schema
touch, no `mode` collision. No accidental shared-state mutation. Build and
targeted suites green.
