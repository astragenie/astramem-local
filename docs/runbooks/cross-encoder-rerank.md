# Operator runbook — cross-encoder rerank stage (issue #26, ADR-005)

## What it is

A post-fusion rerank stage in the local hybrid search pipeline (`src/search/search.ts`). After the
existing BM25 + cosine + importance + freshness fusion (`src/search/fuse.ts`) produces a ranked
candidate list, an optional second pass re-scores the top `crossEncoder.topK` candidates against
the query using a cross-encoder-style provider and re-sorts that window. Everything beyond
`topK` is left in its original fused order.

**Status:** OFF by default, everywhere (`crossEncoder.enabled: false`). ADR-005
(`docs/adr/ADR-005-retrieval-contract.md`) ruled that local ships v1 with "no reranker (CPU
budget)" — this stage is the config-flagged seam that lets a future rollout happen by config flip
+ published eval evidence, mirroring how the cloud engine (astragenie/memory) shipped its
`ICrossEncoderRanker` stub-off-by-default before its own staged rollout (see issue #26 for the
cloud runbook this mirrors). **P2 retrieval overhaul (2026-07-20, WT-B)** landed the real local
provider this gap always referred to — see "P2: real in-process ONNX cross-encoder" below — but did
NOT flip the shipped default: that is a Gate A decision made after all three Wave-1 tracks merge
(`docs/specs/20260720-retrieval-overhaul-plan.md`), not a single track's own A/B, however positive.

Three providers are implemented:

- `provider: 'mock'` — a deterministic lexical (Jaccard token-overlap) scorer. It carries **no
  real semantic signal**; it exists to prove the stage is correctly wired end-to-end (unit tests,
  the ADR-005 eval harness) without a network/model dependency.
- `provider: 'onnx'` (P2, `DEFAULT_MODEL_LABEL` when `enabled: true` is set — see
  `defaultConfig()`) — a real, compact, in-process cross-encoder
  (`Xenova/ms-marco-MiniLM-L-6-v2`, ~23MB q8) via `@huggingface/transformers`
  (`src/search/onnx-cross-encoder.ts`), same offline-first / lazy-load / CPU-only posture as the
  `onnxEmbed` provider (ADR-018). No sidecar process to run. See "P2: real in-process ONNX
  cross-encoder" below.
- `provider: 'http'` — a real cross-encoder sidecar client (`HttpCrossEncoderProvider`, issue
  #26/#94). It POSTs the query + candidate texts to `crossEncoder.sidecarUrl` and maps the
  response back to per-candidate scores. See "HTTP provider — endpoint contract" and "Running a
  sidecar" below before enabling it. Requires `sidecarUrl`; `buildCrossEncoderProvider` throws a
  clear config error at provider-build time (startup) if it's missing rather than silently
  no-opping. Now an optional acceleration path (e.g. a GPU-hosted sidecar), not the only real
  implementation.

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
  topK: 40           # candidates considered for rerank (cost/latency control — tuned 2026-07-20,
                      # see "topK tuning" below)
  timeoutMs: 1500    # hard cap — see "P2: real in-process ONNX cross-encoder" for why this
                      # was raised from the original 300ms
```

`config.yaml` — real in-process ONNX cross-encoder (P2, local-only, no sidecar to run):

```yaml
crossEncoder:
  enabled: true
  provider: 'onnx'
  topK: 40           # candidates considered for rerank — tuned default (see "topK tuning" below);
                      # the P2 plan's original target window was 40-60
  timeoutMs: 1500    # hard cap — CPU-realistic (see below)
  # model: 'ms-marco-MiniLM-L-6-v2'   # optional — this is already the default
  # onnx:
  #   cacheDir: 'C:\custom\onnx-cache' # optional — defaults to <dataDir>/models/onnx/
  #   numThreads: 4                    # optional — defaults to core-count-aware cap
```

`config.yaml` — real HTTP sidecar (optional acceleration path, e.g. a GPU-hosted deployment):

```yaml
crossEncoder:
  enabled: true
  provider: 'http'
  topK: 40                                  # candidates considered for rerank
  timeoutMs: 1500                           # hard cap; also the HTTP request's own abort budget
  sidecarUrl: 'http://127.0.0.1:8081/rerank' # required for provider: 'http'
  model: 'BAAI/bge-reranker-v2-m3'           # optional — forwarded in the request body when set
```

Stop the daemon before hand-editing `config.yaml` (config is read once at boot — see the "Config
reload" note in `CLAUDE.md`), then restart.

There is currently no reason to flip `provider: 'mock'` on for real traffic: it is a lexical
scorer with no semantic value over the existing BM25 leg, so enabling it today would spend latency
budget for no quality gain. It exists so the seam, the eval gate, and the timeout/fallback
behavior are all exercised and provable without a network dependency.

`provider: 'onnx'` and `provider: 'http'` both give real semantic reranking, but see
"Eval-evidence requirement" below before flipping the *shipped default* — publishing a
recall@10/NDCG@10 (or the retrieval-overhaul plan's token-F1) delta is still the bar for that,
even though a real local provider now exists with no sidecar required.

## P2: real in-process ONNX cross-encoder (2026-07-20, WT-B)

`OnnxCrossEncoderProvider` (`src/search/onnx-cross-encoder.ts`) is this repo's answer to the gap
both Codex architecture reviews flagged: "no usable local reranker... the mock is Jaccard overlap;
the real provider requires an HTTP sidecar" (`docs/research/20260720-codex-architecture-reviews.md`).
It loads `Xenova/ms-marco-MiniLM-L-6-v2` (sentence-transformers' reference MS MARCO cross-encoder,
ONNX-exported, ~23MB int8-quantized) via `@huggingface/transformers`, the same library, offline-first
directory-snapshot loading (`resolveLocalSnapshotDir`, reused from `onnx.ts` — see that function's
doc comment for the 2026-07-16 outage class this avoids), and CPU-execution-provider-only posture
(ADR-018) that `OnnxEmbedProvider` already established for embeddings. No sidecar process, no GPU
allocation, model loads lazily on first rerank call and is memoized for the daemon's lifetime —
first-call latency was measured at ~2.9s cold (model download + session load) on this repo's own
dev box; every subsequent call reuses the warm session.

Candidates are batched (`crossEncoder.onnx.batchSize`, default 16 pairs per `model()` call) to
bound peak memory rather than tokenizing all `topK` candidates in one shot. Scoring is `query +
atom text + evidence excerpt` when a hit carries an `evidence` field (`buildRerankCandidateText`
in `rerank.ts`) — today's actual `SearchHit` shape from `search.ts` does not populate `evidence`
yet, so this degrades to atom text alone until a future change threads `Memory.evidence`
(`contracts/memory.ts`) through `SearchHit`; the hook is forward-compatible and already tested.

**Weight cache:** shares the same `<dataDir>/models/onnx/` root `onnxEmbed` uses (ADR-018 S2) —
different HF repo ids nest under distinct subdirectories, so embed and rerank weights coexist
without collision. Override via `crossEncoder.onnx.cacheDir` or point `crossEncoder.onnx.modelPath`
at an explicit local snapshot for air-gapped installs (same lookup rule as `onnxEmbed.modelPath` —
see `resolveLocalSnapshotDir`'s doc comment).

**Timeout:** the original 300ms cap assumed a warm GPU sidecar — unrealistic for CPU-only
in-process inference. Default raised to 1500ms. The provider logs `device: 'cpu'` +
`latency_ms` on every call (structured pino log, this repo's only "metrics" surface) so p50/p95
can be tracked separately from any future GPU-backed `http` sidecar's own numbers.

**A/B evidence (2026-07-20, same store, same day, cheap dev recipe per the retrieval-overhaul
plan's measurement protocol — conv-26, n=152, gpt-5-mini answerer, token-F1 primary + gpt-5-mini
llm-judge secondary):**

| | token-F1 cat-avg | llm-judge cat-avg |
|---|---|---|
| rerank OFF (baseline) | 0.4016 | 0.4129 |
| rerank ON (`provider: 'onnx'`) | 0.4232 | 0.4761 |
| **delta** | **+0.0216** | **+0.0632** |

Both metrics improved on the same store, same day — the token-F1 delta lands at the low end of the
plan's expected +0.02–0.05 range for P2, and the treatment run's absolute numbers (0.4232 /
0.4761) beat the previously-recorded Wave-0 baseline (0.4073 / 0.4541) despite the baseline re-run
on this same day scoring slightly below its own historical number (day-variance, ±6pt/day —
consistent with the LEDGER's documented variance). Per-category: multi-hop (cat 1) and open-domain
(cat 3) improved the most; single-hop (cat 4) token-F1 dipped slightly (0.4736 → 0.4509) while its
llm-judge score also dropped (0.6429 → 0.5857) — plausibly the reranker occasionally demotes an
already-correct top-1 hit in favor of a lexically-closer but less complete one; worth watching at
Gate A with the full-suite CoT re-judge, not a reason to revert on this single-conversation sample.
Reproduce: `bun scripts/eval/locomo/oracle/ab-baseline.mts --datadir <scratch-copy> --rerank
off|onnx` (the `--rerank` flag is new in this change, threaded through
`scripts/eval/shared/spawn-daemon.ts`'s existing `EvalCrossEncoderOverride`).

This is preliminary, single-track evidence — see "Eval-evidence requirement" below for why the
shipped default (`crossEncoder.enabled`) is NOT flipped by this change despite the positive result.

## topK tuning + model swap (2026-07-20, same-day follow-up to the WT-B A/B above)

Same measurement protocol as the A/B evidence above (cheap dev recipe: conv-26, n=152,
gpt-5-mini answerer, token-F1 primary + gpt-5-mini llm-judge secondary, scratch copy of the same
pre-ingested store, single day — so these deltas are comparable to each other but NOT
directly comparable across different days to the WT-B numbers above, which is why the first row
here re-anchors rerank-off/on at the (then-current) default topK 50):

| variant | token-F1 cat-avg | llm-judge cat-avg | multi-hop (cat 1) f1 / judge |
|---|---|---|---|
| rerank OFF (anchor) | 0.3938 | 0.4075 | 0.2669 / 0.2188 |
| rerank ON, onnx, topK=50 (then-default) | 0.4163 | 0.4811 | 0.2668 / 0.2500 |
| rerank ON, onnx, **topK=40** | **0.4115** | **0.4907** | **0.2849 / 0.2813** |
| rerank ON, onnx, topK=100 | 0.3910 | 0.4683 | 0.2771 / 0.2813 |
| rerank ON, onnx, `bge-reranker-base`, topK=40 | 0.3870 | 0.3968 | 0.2218 / 0.1563 |

**topK=40 is the new default** (`defaultConfig()`, `src/config/config.ts`): best llm-judge
cat-avg of the sweep, token-F1 essentially tied with topK=50 (within day-to-day noise), and
clearly the best multi-hop result — topK 50/100 leave multi-hop llm-judge well below topK=40's
0.2813. topK=100 is a **net regression vs. even the rerank-OFF baseline on token-F1** (0.3910 <
0.3938) — a wider candidate pool pulls in more distractors than it resolves, confirming the P2
plan's 40-60 target window should be read as "don't go wider," not "40-60 are interchangeable."

**Model swap (`Xenova/bge-reranker-base`, XLM-RoBERTa, ~266MB q8 vs MiniLM-L-6's ~23MB) is a
clear loss, not just "not worth the size":** worse on both metrics than even the un-reranked
baseline, AND 5 of 152 `/recall` requests hit the route's own 30s `handler_deadline_exceeded`
timeout during this run — the larger model's per-batch CPU inference latency pushed some
requests past the whole-request budget (separate from, and outside, `crossEncoder.timeoutMs`,
which only bounds the rerank sub-call). The reported bge-reranker-base numbers are therefore
UNDERSTATED (5 abstentions scored as wrong), but the size/latency evidence alone already rules
it out for this repo's "compact local cross-encoder" posture — kept in
`RERANK_MODEL_REGISTRY` (`src/search/onnx-rerank-registry.ts`) as an evaluated, addressable
option (`crossEncoder.model: 'bge-reranker-base'`), not a recommendation.

**Not done here — the evidence-excerpt hook is still inert:** `buildRerankCandidateText`
(`rerank.ts`) already appends `hit.evidence` to the text scored against the query when present,
but `SearchHit` (`search.ts`) never populates `evidence` today, so every rerank call in this
sweep scored atom text alone. Threading `Memory.evidence` (`contracts/memory.ts`) through
`SearchHit` is a `search.ts` change — out of this runbook's ownership — but is a plausible next
lever: the P2 plan's own rationale for the hook was that a reranker judging query-vs-full-atom
text is a strictly worse signal than query-vs-the-specific-evidence-span an atom was extracted
from.

Reproduce: `bun scripts/eval/locomo/oracle/ab-baseline.mts --datadir <scratch-copy> --rerank
onnx` after editing `defaultConfig().crossEncoder.topK`/`model` in `src/config/config.ts` (the
`--rerank` flag only toggles `enabled`/`provider` via `EvalCrossEncoderOverride` — it does not
carry `topK` or `model`, so a topK/model sweep edits the default and rebuilds between passes).

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

## Sidecar vs. embedded model (FEAT-452 decision — SUPERSEDED by P2, 2026-07-20)

FEAT-452 raised an open product question: does the already-shipped `HttpCrossEncoderProvider`
talking to a `127.0.0.1` sidecar actually satisfy astramem-local's "local-only, no-cloud-moat"
goal, or is an embedded in-process model (e.g. `bge-reranker-v2-m3` run directly via
Ollama/ONNX, no separate process) required? At the time: "the `127.0.0.1` HTTP sidecar already
satisfies the local-only requirement... An embedded in-process model is explicitly deferred, not
planned... Revisit only if a concrete operator pain point with running a separate sidecar process
ever surfaces."

**That pain point surfaced: the retrieval overhaul plan's Codex architecture reviews both
independently flagged "no usable local reranker... the mock is Jaccard overlap; the real provider
requires an HTTP sidecar" as a real gap** (`docs/research/20260720-codex-architecture-reviews.md`)
— an operator who wants real reranking without standing up a separate Docker/TEI process had no
path. `provider: 'onnx'` (P2, 2026-07-20 — see "P2: real in-process ONNX cross-encoder" above)
closes it: model-loading startup cost is now lazy (first `score()` call, not daemon boot) and
memoized, and the model is small enough (~23MB) that daemon binary size / CPU contention concerns
from the original FEAT-452 decision don't materialize the way they might for a multi-hundred-MB
model. The `http` sidecar path remains fully supported as an *optional acceleration* (e.g. a
GPU-hosted deployment for higher throughput), not the only real implementation anymore.

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
and (as of P2) `OnnxCrossEncoderProvider` being implemented removes the *engineering* blocker, but
not this evidence bar. Before any future PR proposes flipping the shipped default to
`provider: 'onnx'` / `'http'` / `enabled: true`:

1. For `http`: stand up a sidecar (see "Running a sidecar" above) against a representative corpus.
   For `onnx`: no separate process needed — the model loads on first use.
2. Re-run the ADR-005 eval harness (recall@10/NDCG@10) AND/OR the retrieval-overhaul plan's
   token-F1 dev recipe against a representative corpus, and publish the delta versus the
   rerank-off baseline (the same "publish the delta" gate ADR-005 imposed on cloud's rollout). The
   ADR-005 harness only exercises the mock provider today (deterministic, no live model/sidecar
   dependency in CI); a real-provider run is a manual/ad-hoc evaluation, not something CI can gate
   on without a live dependency.
3. Only then is there a data-backed case for changing `crossEncoder.enabled` / `provider`'s
   default.

**P2 status (2026-07-20, WT-B):** step 2 has a first data point — see "P2: real in-process ONNX
cross-encoder" above for the measured token-F1/llm-judge delta (+0.0216 / +0.0632, one conversation,
one day). This is real, positive, single-track evidence, but it is deliberately **not** treated as
satisfying this gate on its own: the retrieval-overhaul plan's Gate A (after all three Wave-1
tracks — hybrid+RRF fusion, this reranker, distill/graph — merge) is where the shipped default gets
decided, using the full-suite CoT re-judge, not a single track's own conv-26 sample. `defaultConfig()`
still ships `crossEncoder.enabled: false` after this change; only `provider` changed (mock -> onnx)
so that an operator who DOES opt in gets the real reranker, not the semantically-inert mock.
