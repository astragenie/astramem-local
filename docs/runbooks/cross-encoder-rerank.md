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

## Rerank provenance (FEAT-452)

Before FEAT-452, `applyRerank` overwrote a reranked hit's `score` in place with the
cross-encoder's own value, destroying the fused score — a caller had no way to tell a
fused-only hit from a reranked one, or to recover what fusion originally produced.

Now a hit the stage actually reorders gains three additive fields instead, and `score`
is left untouched (always the original fused value):

- `reranked: true`
- `rerank_score: number` — the clamped `[0,1]` cross-encoder score
- `explanation.signals.cross_encoder: { raw, weight, final }` — the same value, shaped
  to match ADR-005's `ScoreExplanation.signals` open map
  (`contracts/schemas/retrieval-result.v1.schema.json`), so it validates as just another
  signal in that contract without a schema change

All three are absent (not `false`/`0`) on a hit the stage never touched — rerank
disabled, the hit fell beyond `opts.rerank.topK`, or the whole-call timeout/error
fallback fired — so an un-reranked hit's shape is unchanged from before this field
existed. Surfaced on `GET /search` and `POST /recall` (the two routes that resolve
`config.crossEncoder` into `SearchOpts.rerank` — see "Where it's wired" above); MCP
`search_memory`/`recall_memory` inherit it for free since they call the same `search()`.

**`why_memory` is deliberately NOT rerank-aware.** `why_memory` (`GET
/memory/:id/why`, `src/server/queries/provenance.ts`) answers "what do we know about
this stored atom", keyed only by memory id — it has no notion of *which search request*
served that atom, so there is no stored per-request linkage to say "this atom was
reranked when it was returned for query Q". Recording that would mean persisting
per-serve rerank state that doesn't exist today (and isn't proposed here) purely to
answer a question the receipt was never designed to answer. Rerank provenance is
therefore scoped to what's honestly derivable: the search/recall response itself,
per the fields above. If a future FEAT wants `why_memory` to answer "was I ever served
via a reranked result," that requires a new stored linkage (e.g. an event logged at
serve time) as its own, separately-scoped change — not an extension of the existing
receipt query.

## Local observability (FEAT-452)

The rerank stage has no dedicated metrics registry (this repo doesn't have one anywhere
— see e.g. `src/providers/llm/ollama.ts`, `src/providers/embed/ollama.ts`,
`src/pipeline/handlers/distill-events.ts`): every provider-facing stage reports via
structured pino log lines with `latency_ms` + an outcome field instead, and a log
aggregator turns those into counters/histograms. `applyRerank` (`src/search/rerank.ts`)
follows the same pattern:

- `'rerank stage start'` (info) — `{ topK, candidates, provider }` before calling the
  provider.
- `'rerank stage complete'` (info) — `{ outcome: 'ok', latency_ms, candidates }` when
  the provider call succeeds within budget.
- `'rerank stage fallback to un-reranked order'` (warn) — `{ outcome: 'timeout' |
  'error', latency_ms, error_message }` when the whole-call fallback fires (see
  "Cost / latency tradeoff" below for what triggers each).

There is no `outcome: 'disabled'` log line: when `crossEncoder.enabled` is `false`
(the default), `SearchOpts.rerank` is `undefined` and `applyRerank` is never called —
by design, matching the "search() takes zero extra branches" guarantee this stage has
always had. A search request with no rerank log line at all *is* the disabled case;
there is nothing to count per-request when the stage doesn't run.

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

## Sidecar vs. embedded model (FEAT-452 decision)

FEAT-452 raised an open product question: does the already-shipped `HttpCrossEncoderProvider`
talking to a `127.0.0.1` sidecar actually satisfy astramem-local's "local-only, no-cloud-moat"
goal, or is an embedded in-process model (e.g. `bge-reranker-v2-m3` run directly via
Ollama/ONNX, no separate process) required? **Decision: the `127.0.0.1` HTTP sidecar already
satisfies the local-only requirement — all inference stays on the operator's own machine, no
network hop ever leaves `localhost`, and nothing about "local-only" implies "same process as the
daemon."** An embedded in-process model is explicitly **deferred, not planned**: it would trade a
one-time sidecar setup (documented above under "Running a sidecar") for daemon binary size,
model-loading startup cost on every daemon boot, and CPU contention with the daemon's own event
loop, for zero improvement to the actual constraint (data never leaving the local machine) that
motivated the "local-only" goal in the first place. Revisit only if a concrete operator pain point
with running a separate sidecar process ever surfaces — none has today.

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
