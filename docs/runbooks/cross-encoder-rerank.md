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

Two providers are implemented:

- `provider: 'mock'` (the default when `enabled: true` without further config) — a deterministic
  lexical (Jaccard token-overlap) scorer. It carries **no real semantic signal**; it exists to
  prove the stage is correctly wired end-to-end (unit tests, the ADR-005 eval harness) without a
  network/model dependency.
- `provider: 'http'` — a real cross-encoder sidecar client (`HttpCrossEncoderProvider`, issue
  #26/#94). It POSTs the query + candidate texts to `crossEncoder.sidecarUrl` and maps the
  response back to per-candidate scores. See "HTTP provider — endpoint contract" and "Running a
  sidecar" below before enabling it. Requires `sidecarUrl`; `buildCrossEncoderProvider` throws a
  clear config error at provider-build time (startup) if it's missing rather than silently
  no-opping.

## Where it's wired

- `src/search/search.ts` — the stage itself, gated by `SearchOpts.rerank` (`undefined` = stage
  never runs, byte-identical to pre-rerank behavior).
- `src/search/rerank.ts` — `CrossEncoderProvider` interface, `MockCrossEncoderProvider`,
  `HttpCrossEncoderProvider`, `buildCrossEncoderProvider` (factory), `resolveRerankOpts` (config →
  `SearchOpts.rerank`), `applyRerank` (the reorder + timeout/fallback logic).
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

`config.yaml` — mock provider (no network dependency, no semantic signal):

```yaml
crossEncoder:
  enabled: true
  provider: 'mock'
  topK: 50           # candidates considered for rerank (cost/latency control)
  timeoutMs: 300     # hard cap — mirrors cloud's DEC-011/012 300ms budget
```

`config.yaml` — real HTTP sidecar:

```yaml
crossEncoder:
  enabled: true
  provider: 'http'
  topK: 50                                  # candidates considered for rerank
  timeoutMs: 300                            # hard cap; also the HTTP request's own abort budget
  sidecarUrl: 'http://127.0.0.1:8081/rerank' # required for provider: 'http'
  model: 'BAAI/bge-reranker-v2-m3'           # optional — forwarded in the request body when set
```

Stop the daemon before hand-editing `config.yaml` (config is read once at boot — see the "Config
reload" note in `CLAUDE.md`), then restart.

There is currently no reason to flip `provider: 'mock'` on for real traffic: it is a lexical
scorer with no semantic value over the existing BM25 leg, so enabling it today would spend latency
budget for no quality gain. It exists so the seam, the eval gate, and the timeout/fallback
behavior are all exercised and provable without a network dependency.

`provider: 'http'` gives real semantic reranking, but see "Eval-evidence requirement" below before
flipping the *shipped default* — publishing a recall@10/NDCG@10 delta against your own corpus is
still the bar for that, even though the client is now implemented.

## HTTP provider — endpoint contract

`HttpCrossEncoderProvider` (`src/search/rerank.ts`) speaks the common cross-encoder sidecar
contract — the same shape as a Hugging Face Text Embeddings Inference (TEI) `/rerank` deployment
(and the cloud engine's `HttpCrossEncoderRanker` → TEI sidecar, issue #26):

- **Request:** `POST <sidecarUrl>` with JSON body

  ```json
  { "query": "<query text>", "texts": ["<candidate 1 text>", "<candidate 2 text>", "..."], "model": "<optional, only if crossEncoder.model is set>" }
  ```

  `texts[i]` corresponds positionally to the `i`-th post-fusion candidate handed to the reranker
  (up to `topK` of them).

- **Response:** either shape is accepted —

  - a bare TEI-native array: `[{ "index": 0, "score": 0.91 }, { "index": 1, "score": 0.04 }, ...]`
  - or wrapped: `{ "results": [{ "index": 0, "score": 0.91 }, ...] }`

  `index` is the position into the request's `texts` array (i.e. which candidate the score
  belongs to); `score` need not be pre-clamped to `[0,1]` — the stage clamps defensively. A
  candidate whose index is missing from the response falls back to its original fused score
  (`applyRerank`'s existing missing-id semantics).

- **Failure handling:** a non-2xx response, a network error, or a response with no parseable
  `index`/`score` array all cause `HttpCrossEncoderProvider.score()` to throw. It never returns a
  partial or empty map on failure — that would look like "no candidate matched" to `applyRerank`
  instead of "the sidecar is unreachable". `applyRerank` is the single place a thrown error (or a
  timeout — see below) becomes the whole-call fallback to the un-reranked fused order; the search
  request itself never fails because of a reranker problem.

## Running a sidecar

Any TEI-compatible reranker deployment works. The reference model from the cloud runbook (issue
#26) is `BAAI/bge-reranker-v2-m3`. A minimal local Docker example (Hugging Face's
`text-embeddings-inference` image):

```powershell
docker run -p 8081:80 --pull always ghcr.io/huggingface/text-embeddings-inference:cpu-latest `
  --model-id BAAI/bge-reranker-v2-m3
```

Point `crossEncoder.sidecarUrl` at `http://127.0.0.1:8081/rerank` (TEI's default rerank route) and
set `crossEncoder.model` only if your sidecar actually multiplexes several models behind one URL —
most single-model TEI deployments ignore an extra `model` field in the request body, so it's safe
to omit.

Sidecar provisioning and prod placement (container orchestration, GPU vs CPU image, autoscaling)
are operator/deployment decisions outside this repo's code.

## Cost / latency tradeoff

- **Latency:** the stage runs synchronously in the request path, after fusion and before the
  result is returned. `timeoutMs` (default 300ms, matching the cloud engine's hard cap) bounds the
  worst case for the whole rerank stage; `HttpCrossEncoderProvider` also applies `timeoutMs` as its
  own HTTP request abort budget (`AbortSignal.timeout`), so a hung sidecar connection is cut loose
  around the same budget rather than left running indefinitely. A slower or failing provider call
  falls back to the un-reranked fused order for the *entire* call (never a partial reorder) rather
  than blocking the response. With the mock provider this cost is negligible (pure in-process
  string tokenization); the HTTP provider adds one network round-trip per search — budget
  accordingly against local's existing p95 < 150ms warm-cache target (ADR-005). A CPU-hosted TEI
  reranker sidecar typically adds low tens-of-ms per request for `topK` ≈ 50 short texts; a
  GPU-hosted one is faster but is real added infrastructure, not a free lunch.
- **CPU/cost:** the mock provider's cost is O(topK × tokens), effectively free. The HTTP provider
  shifts that cost to the sidecar process (the reason ADR-005 ruled reranking OFF for local's v1
  CPU budget in the first place — cloud has dedicated infra for this, local runs on the user's own
  machine, so running a sidecar is a deliberate resource trade the operator opts into).
- **`topK` controls the tradeoff directly:** only the top `topK` fused candidates are reranked, not
  the full candidate pool, so both latency and sidecar compute cost scale with `topK`, not corpus
  size — and, for the HTTP provider, `texts` payload size scales with `topK` too.

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
*real* cross-encoder would improve or regress ranking quality on real queries. `HttpCrossEncoderProvider`
being implemented removes the *engineering* blocker, but not this evidence bar. Before any future
PR proposes flipping the shipped default to `provider: 'http'` / `enabled: true`:

1. Stand up a sidecar (see "Running a sidecar" above) against a representative corpus.
2. Re-run the ADR-005 eval harness with `provider: 'http'` configured and publish the
   recall@10/NDCG@10 delta versus the rerank-off baseline (the same "publish the NDCG delta" gate
   ADR-005 imposed on cloud's rollout). The harness only exercises the mock provider today
   (deterministic, no live sidecar dependency in CI); a real-provider run is a manual/ad-hoc
   evaluation against your own sidecar, not something CI can gate on without a live dependency.
3. Only then is there a data-backed case for changing `crossEncoder.enabled` / `provider`'s
   default.
