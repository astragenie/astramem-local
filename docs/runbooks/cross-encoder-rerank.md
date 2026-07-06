# Operator runbook — cross-encoder rerank stage (issue #26, ADR-005)

## What it is

A post-fusion rerank stage in the local hybrid search pipeline (`src/search/search.ts`). After the
existing BM25 + cosine + importance + freshness fusion (`src/search/fuse.ts`) produces a ranked
candidate list, an optional second pass re-scores the top `crossEncoder.topK` candidates against
the query using a cross-encoder-style provider and re-sorts that window. Everything beyond
`topK` is left in its original fused order.

**Status:** OFF by default, everywhere. ADR-005 (`docs/adr/ADR-005-retrieval-contract.md`) ruled
that local ships v1 with "no reranker (CPU budget)" — this stage is the config-flagged seam that
lets a future rollout happen by config flip + published eval evidence, mirroring how the cloud
engine (astragenie/memory) shipped its `ICrossEncoderRanker` stub-off-by-default before its own
staged rollout (see issue #26 for the cloud runbook this mirrors).

Only one provider is implemented today: `provider: 'mock'`, a deterministic lexical (Jaccard
token-overlap) scorer. It carries **no real semantic signal** — it exists to prove the stage is
correctly wired end-to-end (unit tests, the ADR-005 eval harness) without a network/model
dependency. A real cross-encoder (e.g. an HTTP sidecar serving `BAAI/bge-reranker-v2-m3` or
similar, matching the cloud runbook's proposal) is a **documented TODO** — see "Real provider TODO"
below. Selecting `provider: 'http'` today throws a clear error at provider-build time rather than
silently no-opping.

## Where it's wired

- `src/search/search.ts` — the stage itself, gated by `SearchOpts.rerank` (`undefined` = stage
  never runs, byte-identical to pre-rerank behavior).
- `src/search/rerank.ts` — `CrossEncoderProvider` interface, `MockCrossEncoderProvider`,
  `buildCrossEncoderProvider` (factory), `resolveRerankOpts` (config → `SearchOpts.rerank`),
  `applyRerank` (the reorder + timeout/fallback logic).
- Call sites that resolve `config.crossEncoder` into `SearchOpts.rerank` and pass it to `search()`:
  - `GET /search` and `POST /recall` (`src/server/routes/search.ts`)
  - MCP tools `search_memory` / `recall_memory` (`src/mcp/server.ts`)
- **Not wired** (deferred, no behavior to gate since the feature is off by default): the CLI
  `search` command, the debug dashboard search page. Both call the same `search()` function, so
  wiring them later is a small, additive change — add `rerank: resolveRerankOpts(config)` to their
  `SearchOpts` the same way the two call sites above do.
- The `debug: true` path (`SearchDebugHit[]`, used by the search-debug dashboard) **never**
  invokes the rerank stage, by construction — it returns before the rerank stage is reached. Debug
  output always reflects the pre-rerank fusion breakdown, which is its whole purpose (explaining
  fusion, not the rerank layer on top of it).

## Config to enable

`config.yaml`:

```yaml
crossEncoder:
  enabled: true
  provider: 'mock'   # only implemented provider today — see "Real provider TODO"
  topK: 50           # candidates considered for rerank (cost/latency control)
  timeoutMs: 300     # hard cap — mirrors cloud's DEC-011/012 300ms budget
```

Stop the daemon before hand-editing `config.yaml` (config is read once at boot — see the "Config
reload" note in `CLAUDE.md`), then restart.

There is currently no reason to flip this on for real traffic: `provider: 'mock'` is a lexical
scorer with no semantic value over the existing BM25 leg, so enabling it today would spend latency
budget for no quality gain. This config exists so the seam, the eval gate, and the timeout/fallback
behavior are all exercised and provable *before* a real provider lands — not so an operator flips
it on now.

## Cost / latency tradeoff

- **Latency:** the stage runs synchronously in the request path, after fusion and before the
  result is returned. `timeoutMs` (default 300ms, matching the cloud engine's hard cap) bounds the
  worst case; a slower or failing provider call falls back to the un-reranked fused order for the
  *entire* call (never a partial reorder) rather than blocking the response. With the mock
  provider this cost is negligible (pure in-process string tokenization); a real HTTP sidecar
  provider would add a network round-trip per search — budget accordingly against local's existing
  p95 < 150ms warm-cache target (ADR-005).
- **CPU/cost:** the mock provider's cost is O(topK × tokens). A real provider would add sidecar
  compute cost per query (the reason ADR-005 ruled it OFF for local's v1 CPU budget in the first
  place — cloud has dedicated infra for this, local runs on the user's machine).
- **`topK` controls the tradeoff directly:** only the top `topK` fused candidates are reranked, not
  the full candidate pool, so cost scales with `topK`, not corpus size.

## Rollback

Set `crossEncoder.enabled: false` (or delete the `crossEncoder` block — that's the default) and
restart the daemon. There is no data migration or schema involved — the rerank stage is a pure
in-memory re-sort of an already-fused result list; disabling it returns to exactly the pre-rerank
ranked order with no other side effects.

If a provider call regresses quality or availability, the stage's own timeout/fallback already
degrades to "reranker unavailable" behavior automatically (un-reranked fused order) — rollback via
config is only needed to stop paying the latency/cost cost of *attempting* rerank.

## Eval-evidence requirement

Per ADR-005: any change to local's default ranking behavior (which flipping `crossEncoder.enabled`
to `true` in the shipped default config would be) must not regress the recall@10 / NDCG@10
regression floors enforced by `tests/eval/retrieval-eval.test.ts` (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7).

`describe('issue #26: cross-encoder rerank gate', ...)` in that file proves both states clear the
floor today:

- rerank OFF (`defaultConfig()`, i.e. today's actual default): floors hold (existing baseline).
- rerank ON (`MockCrossEncoderProvider`, both via a direct `RerankOpts` and via
  `resolveRerankOpts(config)`): floors still hold.

This is necessary but **not sufficient** evidence to ever flip the *shipped default* to `true`:
the mock provider carries no real semantic signal, so "floors still hold with rerank on" here only
proves the stage doesn't silently break search — it says nothing about whether reranking with a
*real* cross-encoder would improve or regress ranking quality on real queries. Before any future
PR proposes flipping the default:

1. Implement the real provider (see TODO below) against a live corpus.
2. Re-run the eval harness with that provider and publish the recall@10/NDCG@10 delta versus the
   rerank-off baseline (the same "publish the NDCG delta" gate ADR-005 imposed on cloud's rollout).
3. Only then is there a data-backed case for changing `crossEncoder.enabled`'s default.

## Real provider TODO

`provider: 'http'` in `config.crossEncoder` and `buildCrossEncoderProvider()`
(`src/search/rerank.ts`) are the intended extension point. To implement:

1. Add an `HttpCrossEncoderProvider implements CrossEncoderProvider` (same file) that POSTs
   `{ query, candidates: [{id, text}] }` to `config.crossEncoder.sidecarUrl` and maps the response
   back to `Map<id, score>` — mirrors the cloud engine's `HttpCrossEncoderRanker` → TEI sidecar
   shape described in issue #26.
2. Wire `sidecarUrl` validation into `buildCrossEncoderProvider` (throw if `provider === 'http'`
   and `sidecarUrl` is unset).
3. Re-run the ADR-005 eval harness with the real provider and publish the delta (see above) before
   considering a default flip.
4. Sidecar provisioning (a second TEI-style container serving a reranker model) and prod placement
   are operator/deployment actions outside this repo's code — out of scope for this seam.

No timeline is attached to this TODO; it is not blocking anything else in the retrieval pipeline.
