---
type: handoff
feature: FEAT-550
slice: SLICE-440
status: complete
branch: feat/550-query-rewrite
tip_sha: 1983c2da8b6ec058d5d57b72d6e58438af361318
worktree: C:\work\mega\astramemory-local-wt550
agent: crew:fullstack-dev
created: 2026-07-18
---

# FEAT-550 / SLICE-440 — pre-recall query rewrite/expansion

## Objective

Implement an optional, config-gated, opt-in-per-call query rewrite/expansion
stage that runs before `search()`'s FTS+vector retrieval: a local LLM call
produces up to `maxVariants` alias/synonym/decomposition query strings,
retrieval runs over the union of the original query and every variant, hits
merge by atom id keeping the MAX score, fail-open to the original query alone
on timeout/error/degenerate output. No re-ranking, no store writes, no
answerer changes (both explicitly out of scope per the FEAT).

## Owner

crew:fullstack-dev, single dispatch, worktree-isolated (`astramemory-local-wt550`,
branch `feat/550-query-rewrite`). No other agent touched this worktree.

## What changed

### New files
- `src/search/query-rewrite.ts` — the stage itself. Mirrors
  `src/search/decompose.ts`/`src/search/rerank.ts`'s ADR-005 seam pattern
  exactly:
  - `QueryRewriter` interface (`rewrite(query, signal?) => Promise<string[]>`)
  - `MockQueryRewriter` — deterministic, network-free (strips a leading
    interrogative word + appends a broadening suffix)
  - `LlmQueryRewriter` — real LLM-backed, JSON-array output via
    `jsonSchema`, `temperature: 0`, tolerant object-fallback parsing (same
    issue #261 precedent `LlmQueryDecomposer` already carries)
  - `resolveQueryRewriteOpts(config, buildLLMProvider)` — `undefined` unless
    `config.search.queryRewrite.mode === 'enabled'`
  - `getQueryVariants(query, opts)` — hard timeout via
    `withAbortableTimeout` (shared util, actually cancels via AbortSignal,
    not just abandons), dedup (case-insensitive, drops echo of original),
    cap at `maxVariants`; returns `[]` (never throws) on timeout, provider
    error, or a "succeeded but useless" result
  - `mergeVariantHits(primary, variants, maxCandidates)` — AC-3 fusion: max
    score by atom id, primary always seeded first, capped total (sorted by
    score, low scorers can be displaced by the cap)
- `tests/search/query-rewrite.test.ts` — unit coverage: MockQueryRewriter
  determinism, resolveQueryRewriteOpts mode/provider branching,
  getQueryVariants timeout/error/echo/degenerate fail-open + real cancellation
  (issue #261-style), mergeVariantHits max-score/cap/union semantics,
  LlmQueryRewriter parsing (array, object-fallback, malformed JSON, cap,
  json:true+temperature:0+jsonSchema, signal forwarding).
- `tests/search/query-rewrite-integration.test.ts` — end-to-end via
  `search()` with a real in-memory SQLite + fake embed: byte-identical when
  undefined/no-expand (AC-1), a second-hop-only hit retrieved when
  expand:true (AC-1), hard-timeout bounded total time (AC-2), thrown-error
  fail-open (AC-2), echo-variant silent fallback (AC-5), max-score-kept
  merge (AC-3), original-always-in-union when variant returns zero hits
  (AC-3), maxCandidates cap (AC-3), debug:true unaffected.

### Modified files
- `src/search/search.ts` — `SearchOpts.queryRewrite?: QueryRewriteOpts` +
  `SearchOpts.expand?: boolean`. Gather block added right after the WS6
  decompose gather block (before the meta-load step) — collects each
  variant's own FTS/vec candidates (entity-filter-scoped, same as WS6),
  extends `allIds` so meta rows are fetched for variant-only ids. Merge
  block added right after the WS6 decompose merge block (before post-fusion
  SQL filters) — fuses each variant separately (own normalization pass,
  same weights/usefulness/entity/agent/uncontested inputs), then
  `mergeVariantHits(rankedFused, variantFusedLists, maxCandidates)`.
  Composes with WS6: a rewrite variant can raise (never lower) an id WS6
  already touched.
- `src/config/config.ts` — `Config['search'].queryRewrite` block (mode:
  off|enabled, provider: mock|llm, model?, maxVariants, timeoutMs,
  maxCandidates), default `{ mode: 'off', provider: 'mock', maxVariants: 3,
  timeoutMs: 1500, maxCandidates: 200 }`, `applyQueryRewriteGovernance`
  (closed-enum validation, never-fatal, mirrors
  `applyMultiHopGovernance`), wired into `loadConfig`'s search composition.
- `src/config/loader.ts` — **wired `applyQueryRewriteGovernance` into
  `loadConfigFromDisk` too** (the REAL boot path), not just `loadConfig()`
  — this file's own doc comment already flags that `loadConfig()` has ZERO
  production callers and two other governance fns were once missed here;
  same class of gap, closed proactively rather than repeated.
- `src/config/writer.ts` — emits `search.queryRewrite` (mode, provider,
  model?, maxVariants, timeoutMs, maxCandidates) — required for the
  FEAT-461 exhaustive round-trip gate (`findMissingConfigKeys`) not to
  flag this new block as a silently-dropped field on the next config
  write-back.
- `src/server/routes/search.ts` — `resolveQueryRewriteOpts` resolved once
  per route factory (mirrors `resolveRerankOpts`/`resolveDecomposeOpts`);
  `expand=true` GET query param; `expand: z.boolean().optional()` on
  `RecallBodySchema` for POST /recall. Also removed a pre-existing unused
  `randomUUID` import (flagged during cleanup pass, not otherwise related
  to this change).
- `src/mcp/server.ts` — same `resolveQueryRewriteOpts` wiring;
  `expand: z.boolean().optional()` arg added to both `search_memory` and
  `recall_memory` tool input schemas, threaded into their `search()` calls.
- `tests/config/writer.test.ts` — added a non-default `queryRewrite` block
  to `buildFullyPopulatedConfig()` (the FEAT-461 exhaustive fixture) so the
  round-trip gate actually exercises the new field.

## AC-by-AC evidence

- **AC-1** (mode off = byte-identical; mode enabled + expand:true = up to
  maxVariants strings): `tests/search/query-rewrite-integration.test.ts`
  — "queryRewrite omitted: byte-identical...", "AC-1: a resolved
  queryRewrite WITHOUT expand:true never invokes the stage", "AC-1:
  config.search.queryRewrite.mode disabled (default) →
  resolveQueryRewriteOpts(config) is undefined end to end", "AC-1:
  expand:true + resolved queryRewrite actually retrieves a variant-only
  hit". `tests/search/query-rewrite.test.ts` — `getQueryVariants` "caps
  output at maxVariants". All PASS.
- **AC-2** (timeout/error → original-query-only, bounded total time, real
  enforced timeout not abandoned): `query-rewrite.test.ts` — "returns []
  and does not throw when the rewriter times out", "...when the rewriter
  rejects", "a timeout actually CANCELS the rewriter (fires its signal)
  instead of abandoning it" (issue #261-style cancellation proof).
  `query-rewrite-integration.test.ts` — "AC-2: a hard timeout degrades to
  original-query-only behavior, bounded total time" (asserts wall-clock
  `<2s` against a decomposer that would otherwise hang 5s), "AC-2: a
  rewriter that throws degrades to original-query-only behavior". All
  PASS.
- **AC-3** (max-score merge by atom id, original always in union, capped
  total): `query-rewrite.test.ts`'s `mergeVariantHits` describe block (5
  tests: max-score-kept, always-includes-primary-on-zero-variant-hits,
  adds-new-variant-only-ids, caps-at-maxCandidates-highest-score-survives,
  sorted-descending). `query-rewrite-integration.test.ts` — "AC-3: merges
  by atom id keeping the MAX score", "AC-3: the original query's hits are
  always in the union even when the variant returns zero hits", "AC-3:
  caps the merged candidate set at maxCandidates". All PASS.
- **AC-4** (LoCoMo `--diagnose` A/B + ADR-005 floors) — **deferred**, per
  dispatch instructions, to the serial measurement lane. What IS verified
  here: `tests/eval/retrieval-eval.test.ts` (the ADR-005 harness itself)
  passes with `queryRewrite` untouched/off throughout — mean recall@10
  0.955 (floor 0.9), mean NDCG@10 0.840 (floor 0.7), all 16 tests green.
  The stage is built so the diagnose harness CAN wire it in (`--diagnose`
  A/B run is out of this dispatch's scope).
- **AC-5** (succeeded-but-degenerate → silent fallback, same as AC-2):
  `query-rewrite.test.ts` — "returns [] when the rewriter succeeds but
  produces only an echo of the original query", "...produces a degenerate
  (blank) result". `query-rewrite-integration.test.ts` — "AC-5: a
  rewriter that succeeds but returns only an echo of the original query
  falls back silently" (asserts identical hit-id order to baseline). All
  PASS.

## Verification run (this session, worktree `astramemory-local-wt550`)

```
bun install                                          # 297 packages, clean
bun run build                                        # tsc -p . — clean, no errors
bunx tsc -p tsconfig.tests.json                       # clean, no errors
bunx vitest run tests/config/ tests/search/ tests/eval/retrieval-eval.test.ts
  → 31 test files, 466 tests, all PASS
bunx vitest run tests/eval/retrieval-eval.test.ts --reporter=verbose
  → 16/16 PASS; mean recall@10=0.955 (floor 0.9), mean NDCG@10=0.840 (floor 0.7)
bunx vitest run tests/mcp/ tests/contracts/              → 20 files / 316 tests PASS
bunx vitest run tests/server/                            → 37 files / 571 tests PASS
```

`ASTRA_SKIP_CONSOLIDATE` was unset before every test run per dispatch
instructions. No live LLM calls were made anywhere — GPU is owned by a
concurrent rebaseline run; every rewriter exercised in tests is either
`MockQueryRewriter` or a hand-built `QueryRewriter` test double (mirrors
`decompose-integration.test.ts`'s `fixedDecomposer` pattern). `LlmQueryRewriter`
is unit-tested against a fake `LLMProvider.chat` stub only, never a real model.

## Confidence

High for AC-1/2/3/5 — each has both isolated unit coverage and an
end-to-end `search()` integration test, and the fusion/merge design
deliberately reuses the exact seam pattern (`resolveXOpts` /
`withAbortableTimeout` / fail-open-to-[]`) already proven correct by
decompose.ts/rerank.ts's own test suites, rather than inventing a new
control-flow shape.

Medium-only on real-model behavior: `LlmQueryRewriter`'s prompt/parsing is
modeled directly on `LlmQueryDecomposer`'s (same issue #261 tolerant
extraction), which IS proven against real qwen3/qwen2.5-coder output in
production — but FEAT-550's own rewrite prompt has never been run against a
live model this session (GPU unavailable). AC-4's LoCoMo `--diagnose` A/B is
the gate that will actually surface whether real-model rewrite variants help
or hurt recall in practice; until that runs, `mode: 'enabled'` should stay
an explicit per-install opt-in, never a shipped default (which the FEAT's
own scope fence already requires).

## Risks / open questions

1. **AC-4 not run** — this was explicitly out of this dispatch's scope
   (serial measurement lane per the coordinator's task framing). Needs a
   follow-up dispatch: `bun run eval:locomo:diagnose` (or equivalent) with
   `search.queryRewrite.mode: 'enabled'` + a real local model, comparing
   rank-miss bucket size and confirming the ADR-005 floors still hold or
   improve. Until that runs, do not flip the shipped default to `enabled`.
2. **`mergeVariantHits`'s cap can displace a low-scoring PRIMARY hit** —
   documented in the function's own doc comment and covered by a dedicated
   test ("caps the merged candidate set at maxCandidates, keeping the
   highest-scoring ids"), but worth flagging explicitly: this is a
   deliberate design choice (the cap is a COST bound on the whole union,
   not a guarantee that every primary hit survives), matching the FEAT's
   literal AC-3 wording ("the original query's hits are ALWAYS included in
   the union" — i.e. at merge time, not post-cap).
3. **No new `ScoreExplanation` signal for a rewrite-only-discovered hit**
   — unlike WS6's `multi_hop` signal, a hit found only via a rewrite
   variant currently gets an explanation with fewer bm25/cosine components
   (since `bm25RawForExplain`/`cosineRawForExplain` are built from the
   PRIMARY candidate lists only). This is a deliberate scope decision (the
   FEAT doesn't require a new wire-visible signal, and CONTRACT-FREEZE
   §2's `final === score` invariant still holds regardless) but a future
   observability pass could add a `query_rewrite` signal mirroring
   `multi_hop` if debugging demand shows up.
4. **Real-model prompt untested live** — see Confidence section above.

## Suggested next handoff

- Dispatch AC-4's LoCoMo `--diagnose` A/B run once GPU capacity frees up
  from the concurrent rebaseline (per the dispatch note: "GPU owned by a
  rebaseline run — NO live LLM calls"). This is the gate for ever setting
  `search.queryRewrite.mode: 'enabled'` in a real install.
- Run `/runner:slice complete --id SLICE-440` / `/crew:review` per the
  normal slice-close ceremony — this handoff covers the BUILD phase only.
