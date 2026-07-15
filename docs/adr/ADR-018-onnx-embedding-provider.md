# ADR-018: In-Process ONNX Embedding Provider (CPU Execution Provider) — VRAM Offload for Extraction

**Status:** Proposed
**Date:** 2026-07-14
**Confidence:** High on the architecture shape (mirrors `OllamaEmbedProvider`/`AzureOpenAIEmbedProvider`
exactly); **Low** on the single highest-risk factual claim — that a maintained ONNX export of
`mixedbread-ai/mxbai-embed-large-v1` exists and reproduces the PyTorch reference closely enough to
avoid a mandatory re-embed. That claim is unverified in this ADR (no web access from this design
session) and is deliberately made the first blocking acceptance criterion of SLICE-1, not an
assumption baked into the plan.
**Tier:** Medium (single-provider addition with a widened contract, cross-cutting config surface,
one new doctor probe path — not a new service, not a schema change).

## Context

The daemon embeds via `OllamaEmbedProvider` (`src/providers/embed/ollama.ts`), calling Ollama's
`/api/embeddings` for `mxbai-embed-large`. Per `docs/research/ollama-vram-ceiling-8gb.md` (repo
memory) and this repo's own `CLAUDE.md`, the dev box is an **RTX 5060 Laptop with an 8151 MiB VRAM
ceiling**. Ollama holds `mxbai-embed-large` resident at ~590 MB–1.2 GB VRAM. The default local
extraction model, `qwen2.5:7b` (`src/doctor/checks/model-fit.ts:82`,
`RECOMMENDED_OLLAMA_MODEL`), needs ~5.9 GB. Loaded together: 6.5–7.1 GB of an 8.15 GB ceiling —
leaving under 1.1–1.6 GB of headroom for KV cache growth on longer transcripts, which is exactly
the margin `checkModelFitCanary`'s `CPU_OFFLOAD_RATIO_FLOOR` check (`model-fit.ts:107-144`) exists
to catch when it's blown (layer-spill to CPU → multi-minute distill jobs, the exact failure mode
`qwen3-8b-breaks-distill-extract.md` and `ollama-vram-ceiling-8gb.md` document).

Moving the embedding call off Ollama and onto an **in-process ONNX Runtime session running the CPU
execution provider (EP)** removes the embedding model's VRAM footprint entirely, freeing that
headroom for the extraction LLM — with the added benefit of "load once at boot" instead of
Ollama's per-request model-residency behavior (Ollama can evict/reload models under memory
pressure from concurrent LLM+embed traffic; an in-process ORT session has no such eviction path,
it's just process memory).

This ADR does **not** touch extraction (LLM) providers, schema, or dim. It adds one new
`EmbedProvider` implementation alongside the two that already exist.

### Patterns Found

- `EmbedProvider` (`src/contracts/embed.ts:37-73`): `name: 'ollama' | 'azure-openai'` (union to
  widen), `model`, `dim`, `queryPrefix?`, `embed(texts, signal?)`, `health()`. Both existing
  implementations follow an identical shape: constructor resolves `dim` from
  `config.embedding.dim` defaulting to `DEFAULT_EMBED_DIM` (1024), `queryPrefix` resolved
  *upstream* by `providers/index.ts` via `resolveEmbedQueryPrefix` and passed in — never computed
  inside the provider.
- `OllamaEmbedProvider` (`src/providers/embed/ollama.ts`) and `AzureOpenAIEmbedProvider`
  (`src/providers/embed/azure-openai.ts`) are near-identical: `combineSignals` (external
  `AbortSignal` + internal `AbortSignal.timeout`, per issue #261), 2-attempt retry on 5xx/network
  error, dim-assert-or-throw on every response, `health()` as a cheap side-channel probe (Ollama:
  `/api/tags` list check; Azure: a 1-item embed ping). The ONNX provider should mirror this shape
  exactly for consistency, substituting "ORT session inference" for "HTTP call."
- `buildEmbedProvider` (`src/providers/index.ts:86-115`) is the **one** place a provider is
  constructed from config — confirmed via grep, no other `EmbedProvider`-construction call site
  exists.
- `embedProbe` (`src/doctor/probes/embed-probe.ts`) is fully generic over `EmbedProvider` — calls
  `provider.embed(['ping'], signal)` and checks `vec.length === expectedDim`. **No change needed**
  for ONNX to be probed; verified as an explicit S2 acceptance item rather than assumed.
  `withAbortableTimeout` already handles cancellation generically.
  `checkModelFitCanary`/`findUnfitOllamaModels` (`src/doctor/checks/model-fit.ts:96-144`) filter on
  `cfg.provider === 'ollama'` and are scoped to `config.llm.{compaction,extraction}` only —
  `config.embedding` is never read there, so **no touch point** for this ADR.
- `config.embedding` (`src/config/config.ts:46-68`): `provider: 'ollama' | 'azure-openai'` (union
  to widen), `model: string`, `dim: number`, `queryPrefix?: string`. `defaultConfig()`
  (`config.ts:919`) ships `{ provider: 'ollama', model: 'mxbai-embed-large', dim:
  DEFAULT_EMBED_DIM }` — **this ADR does not change the default** (constraint #9).
- Provider `name` union is grep-confirmed to have exactly three consumers requiring a touch:
  `src/contracts/embed.ts` (the union itself), `src/config/config.ts` (the config-type union),
  `src/providers/index.ts` (`buildEmbedProvider`'s `if (provider === 'ollama') ... else` branch —
  currently a two-way branch, becomes three-way). `src/cli/providers.ts:27` and
  `src/server/routes/dashboard-html.ts:274` read `config.embedding.provider` generically for
  display (template-string interpolation) — no exhaustive switch, no change needed, confirmed by
  reading both call sites.
- `reembed-dim` (`src/cli/reembed-dim.ts`) already supports "switch provider, keep dim" as an
  unstated but real capability: it reads `cfg` (already reflecting whatever the operator wrote to
  `config.yaml`, including a new `provider: 'onnx'`), builds the embed provider from that config
  via `getProviders(newCfg)`, and requires only that `embed.dim === targetDim` — it does not
  require the model or provider to be unchanged. Passing `--dim 1024` (the current, unchanged
  value) is therefore already the correct "reembed after switching to ONNX" procedure with zero
  new code. This is a load-bearing finding for SLICE-4 (no new CLI surface needed).
- `package.json`: `engines.node: ">=22"`, no existing ONNX/transformers dependency. The repo
  already ships one native-binary dependency
  (`better-sqlite3-multiple-ciphers`) — prebuilt-binary npm install friction is an **existing**
  risk class for this package, not a new one introduced by this ADR.
- No `docs/adr/ADR-018*` exists yet; next number confirmed via `docs/adr/*.md` listing (highest is
  ADR-017).

## Decision

Add a third `EmbedProvider` implementation, `OnnxEmbedProvider`
(`src/providers/embed/onnx.ts`), running ONNX Runtime's **CPU execution provider** in-process,
loaded via `@huggingface/transformers`, targeting `mxbai-embed-large-v1` at its native 1024-dim
output. Ships **opt-in** (`config.embedding.provider: 'onnx'`) — Ollama remains the default.

### Options considered — top-level (how to relieve VRAM contention)

1. **In-process ONNX Runtime, CPU EP** (chosen). Removes the embed model's VRAM footprint to zero;
   process-resident, no network hop, no daemon-lifecycle coupling to another service.
2. **Keep Ollama, but manage residency more aggressively** (e.g. tune Ollama's `keep_alive` to
   evict `mxbai-embed-large` between extraction bursts). *Why rejected:* doesn't eliminate VRAM
   usage, only time-shares it — a reload still costs ~1–2s of latency per cold call, and Ollama's
   swap behavior under concurrent LLM+embed load is exactly the kind of scheduling nondeterminism
   `ollama-vram-ceiling-8gb.md` already blames for symptom instability. Zero code risk but does not
   solve the stated problem, it defers it.
3. **Remote/cloud embedding (Azure OpenAI, already implemented)**. *Why rejected:* the
   `azure-openai` embed provider already exists and already solves VRAM contention (nothing local
   loads at all) — but it reintroduces a network dependency and per-call cost, which conflicts with
   this repo's local-first positioning (`CLAUDE.md`'s "Local-first memory daemon" framing) and with
   the motivating use case (an operator who wants BOTH extraction and embedding local, just not
   competing for the same VRAM). Already available as a config choice today; this ADR is explicitly
   about a *local, no-network* alternative to Ollama, not a redirection to a cloud provider that's
   already shipped.
4. **ONNX Runtime with the CUDA/DirectML GPU EP** instead of CPU EP. *Why rejected for v1:* still
   allocates VRAM — defeats the entire purpose of this ADR. Explicitly out-of-scope (see below);
   CPU EP is the only EP that satisfies the stated goal.
5. **Separate lightweight embedding sidecar process** (e.g. a small Python `fastembed` server
   spoken to over localhost HTTP). *Why rejected:* reintroduces almost all of Ollama's downsides
   (separate process lifecycle, separate health/readiness surface, network hop even if
   loopback) while adding a second language runtime (Python) to a pure-Node/TypeScript codebase,
   for no benefit over an in-process Node-native ONNX session. In-process is strictly simpler given
   `onnxruntime-node` prebuilt bindings exist for all three shipped platforms.

### Sub-decision — library choice

1. **`@huggingface/transformers`** (transformers.js v3, HF-maintained, formerly `@xenova/transformers`)
   — **chosen**. Bundles `onnxruntime-node` internally, ships the model's own `tokenizer.json`
   (guarantees WordPiece-tokenization parity with the reference PyTorch model — this directly
   de-risks the geometry-parity gate below, since a hand-rolled tokenizer is exactly where subtle
   mismatches hide), and exposes a documented `pipeline('feature-extraction', model, { pooling:
   'mean', normalize: true })` API that is the standard mechanism for reproducing
   sentence-embedding output from a BERT-family encoder — matching what `mxbai-embed-large-v1`'s
   own model card specifies (mean pooling + L2 normalize).
2. **Raw `onnxruntime-node` + a separately-sourced tokenizer.** *Why rejected:* more control and a
   smaller dependency tree, but shifts tokenizer correctness (WordPiece vocab, special tokens,
   truncation/padding rules) and pooling/normalization math onto this codebase to get bit-exact —
   precisely the surface where a subtle bug would silently produce plausible-looking-but-wrong
   vectors (the ADR-015 "success and failure look identical" failure class this repo has been bitten
   by before, e.g. entity extraction 87% broken behind a green canary). Rejected because the parity
   risk is the single biggest risk in this whole ADR and this option maximizes exposure to it for a
   marginal footprint saving.
3. **`onnxruntime-web` (WASM backend).** *Why rejected:* no native binary install friction, but
   materially slower than the native CPU EP for a BERT-large-class model doing batch inference, and
   still requires sourcing a separate tokenizer — same downside as option 2 plus a performance
   regression, no offsetting benefit for a server-side daemon (WASM's portability argument matters
   for browser/edge deployment, not for a Node daemon that already ships native
   `better-sqlite3-multiple-ciphers`).
4. **`fastembed-js`** (Qdrant's ONNX-embedding wrapper). *Why rejected:* narrower model catalogue
   and smaller maintenance community than `@huggingface/transformers`; doesn't clearly support
   `mxbai-embed-large-v1` with the exact pooling/prefix configuration this ADR needs, and adds a
   second embedding-oriented dependency surface (this repo would then depend on both
   `@huggingface/transformers`-adjacent tooling for tokenizers used elsewhere, if any, and
   `fastembed-js` for this one path) for no clear advantage over option 1.

### Consequences

- **Positive:** ~590 MB–1.2 GB of VRAM freed for extraction; embed latency likely improves for
  short texts (no HTTP round-trip) but may regress for large batches on CPU vs. a GPU-resident
  Ollama call — not benchmarked in this ADR, flagged for S2/S3 measurement.
- **Positive:** eliminates a live-process dependency (Ollama must be running) for the embedding
  path specifically — daemon boot no longer needs Ollama reachable if `provider: onnx` and
  extraction also uses a non-Ollama provider (e.g. `codex-subscription`).
- **Negative:** adds one native-binary npm dependency chain (`onnxruntime-node` via
  `@huggingface/transformers`) — new install-friction surface on top of the existing
  `better-sqlite3-multiple-ciphers` one, needs verification across win32/linux/darwin ×
  x64/arm64 (SLICE-1).
- **Negative:** CPU inference competes with the daemon's own event loop and any other CPU-bound
  work (SQLite writes, JSON parsing) for CPU time — no VRAM cost, but not a free lunch; needs a
  `numThreads` cap so a burst of embed calls doesn't starve the Fastify event loop or the
  extraction pipeline's own CPU needs.
- **Negative / open:** model weight delivery (see below) means first-run either requires network
  access (download-on-first-use) or a documented offline-preload step — a new operational concern
  the Ollama path never had, since `ollama pull` is already a familiar model-acquisition step for
  those users but ONNX weight download would be a new, less visible one.

## Geometry-parity risk — the gate

**This is where this feature lives or dies** (constraint #2). Two independent risks, both must be
addressed:

### Risk A — does a correct ONNX build of `mxbai-embed-large-v1` even exist?

`@huggingface/transformers` runs pre-exported `.onnx` model files; it does not convert a PyTorch
checkpoint to ONNX at runtime. This ADR does **not** assert that a maintained, parity-verified ONNX
export of `mixedbread-ai/mxbai-embed-large-v1` is available on the Hugging Face Hub — that fact is
unverified from this design session (no web access). **SLICE-1's first acceptance criterion is
resolving this**, with an explicit fallback chain, in priority order:

1. Locate a maintained community or vendor ONNX export of this exact model (commonly published
   under an `onnx-community/*` or similar mirror namespace on HF for popular
   `sentence-transformers`-family models) and pin it by exact HF revision/commit hash (never
   `main`/latest — a silent upstream re-export could shift weights without changing the semver-free
   HF "version").
2. If none exists or the located one fails Risk B's verification, self-convert via the standard
   `optimum-cli export onnx --model mixedbread-ai/mxbai-embed-large-v1` toolchain (one-time,
   offline, Python-based conversion step — not a runtime dependency of the daemon) and vendor the
   resulting `model.onnx` + `tokenizer.json` artifact set to a location the daemon can fetch or
   bundle from (e.g. a dedicated HF Space/repo under this project's control, or a GitHub Release
   asset).
3. If self-conversion also fails to reproduce reference output within tolerance (Risk B), this ADR
   does not have a v1 path forward for `mxbai-embed-large-v1` specifically — escalate back to the
   dispatcher with the measured gap rather than silently shipping a degraded model. Do **not**
   substitute a different 1024-dim model (e.g. `bge-large-en-v1.5`) as a silent fallback — a
   different model is a different geometric space regardless of dim match (constraint #1's own
   framing), and doing so without a fresh ADR decision would violate the "reuse existing DBs"
   goal that motivated pinning to mxbai in the first place.

### Risk B — even with a correct ONNX build, does it reproduce Ollama's output closely enough?

Two independent sources of drift even at identical model weights: (a) Ollama's own
`mxbai-embed-large` GGUF quantization vs. an ONNX export's precision (fp32/fp16/int8) may not be
bit-identical to begin with — Ollama's serving format is already a lossy quantization of the
original weights, so "parity" here means "close enough for retrieval," not "bit-identical to
Ollama," and (b) pooling/normalization implementation differences (mean-pool window over the
attention mask, L2-normalize order-of-operations) between Ollama's internal serving code and
`@huggingface/transformers`'s `pipeline('feature-extraction', ...)`.

**Verification plan (SLICE-3, executed by fullstack-dev/researcher, not by this ADR):**

1. **Cheap pre-gate — cosine similarity on paired output.** Sample N≥200 real memory `content`
   strings (from an existing populated dev DB, or a fixture corpus if none available), embed each
   through both `OllamaEmbedProvider('mxbai-embed-large')` and the new `OnnxEmbedProvider`, compute
   per-pair cosine similarity. Report mean / min / p5 / a histogram. This catches gross
   tokenizer/pooling bugs cheaply (a broken pooling implementation typically shows up as similarity
   well below 0.9, not a subtle miss).
   - **Go/no-go threshold, proposed:** mean cosine ≥ 0.98 → proceed to step 2. Mean cosine < 0.95 →
     treat as Risk A/B failure, do not proceed without root-causing the gap. Between 0.95–0.98 →
     manual review of the worst-percentile pairs before deciding.
2. **Authoritative gate — retrieval-eval floors.** Cosine similarity on paired vectors does not
   prove *nearest-neighbor ranking* is preserved (small, consistent, systematic differences across
   an entire corpus can still reorder a dense neighborhood even at high pairwise cosine). Run the
   ADR-005 harness (`tests/eval/retrieval-eval.test.ts`) with the embed provider swapped to
   `OnnxEmbedProvider` and compare against the existing floors (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7). If
   ONNX embeddings clear the same floors the Ollama-embedded fixture does today, ranking behavior is
   preserved for practical retrieval purposes even if raw cosine values differ slightly from
   Ollama's.
   - **Also verify the RECALL-S1 asymmetry survives:** embed the same query text with and without
     `QUERY_PREFIX_BY_MODEL['mxbai-embed-large']` applied, on both providers, and confirm the
     direction and rough magnitude of the prefix's effect on query-vs-passage similarity matches —
     a pooling difference could plausibly cancel or invert the +17.5 MRR effect this repo already
     measured and depends on.
3. **Record the outcome as a decision, not an assumption.** Write findings to
   `docs/research/<date>-onnx-embed-parity.md` with explicit go/no-go per the thresholds above. Two
   possible shipped postures result, and **the safe default is the second one** unless step 1+2
   both clear:
   - **Parity holds (both gates pass):** a follow-up ADR/config note may declare "switching an
     EXISTING install from `ollama`/`mxbai-embed-large` to `onnx`/`mxbai-embed-large-v1` does not
     require `reembed-dim`" — but that is a *new* claim requiring its own sign-off, not something
     this ADR pre-authorizes.
   - **Parity does not hold, or is unverified:** ONNX ships opt-in with **mandatory** `reembed-dim`
     guidance on switch for any EXISTING install (SLICE-4). This costs nothing extra for a
     **fresh** install with no prior data — `provider: onnx` in `config.yaml` before first ingest
     is a zero-migration path regardless of parity outcome, since there is nothing to preserve.

## Library choice, weight delivery, cross-platform install

**Library:** `@huggingface/transformers` (see Sub-decision above).

**Weight delivery — download-on-first-use, not bundled in the npm tarball.**
`mxbai-embed-large-v1` ONNX weights run roughly 130 MB (int8) to ~440 MB (fp32) — bundling either
into the `astramem-local` npm package (`package.json`'s `files` field currently ships only `dist`,
`migrations`, and docs) would balloon every install regardless of whether the operator ever
enables ONNX. Follow `@huggingface/transformers`'s standard behavior: weights download to a local
cache directory on first `OnnxEmbedProvider` construction/first inference call, keyed by model
id + revision hash. Two config knobs needed for the datadir-scoped, air-gap-aware posture this repo
already takes elsewhere (`%APPDATA%\Astramem`, `~/.config/astramem`):

- `onnxEmbed.cacheDir` — override the default cache location; default should live under this
  repo's existing datadir convention (e.g. `<dataDir>/models/onnx/`), not the HF library's own
  default `~/.cache/huggingface` — keeps all daemon state under one operator-visible root,
  consistent with `%LOCALAPPDATA%\AstraMemory\memory.sqlite` and friends.
- `onnxEmbed.modelPath` — explicit local filesystem override, taking precedence over any download.
  Required for a genuinely offline/air-gapped install (this repo already documents doctor/install
  flows that assume no network dependency beyond Ollama for local providers — ONNX's
  download-on-first-use is a **new** network dependency at first-run time that Ollama's own `pull`
  step already has a precedent for, but it's still worth flagging as new for the local-only
  posture).

**Cross-platform native binary:** `@huggingface/transformers` pulls in `onnxruntime-node`, which
ships prebuilt binaries via npm `optionalDependencies` for win32/linux/darwin ×
x64/arm64 — the same distribution mechanism `better-sqlite3-multiple-ciphers` already uses in this
package. Not a new risk *class*; SLICE-1's acceptance includes confirming `bun install` (this
repo's package manager) resolves the correct prebuilt binary on at least Windows (the primary dev
platform per this session's environment) before treating the dependency as settled.

## Config surface additions

```ts
// src/config/config.ts — Config['embedding']
embedding: {
  provider: 'ollama' | 'azure-openai' | 'onnx';  // WIDENED — was 'ollama' | 'azure-openai'
  model: string;   // for onnx: e.g. 'mxbai-embed-large-v1'
  dim: number;     // unchanged; onnx provider must assert dim === 1024 same as the other two
  queryPrefix?: string;  // unchanged — resolved via resolveEmbedQueryPrefix, model key stays
                          // 'mxbai-embed-large' in QUERY_PREFIX_BY_MODEL regardless of provider
                          // (the prefix is keyed by MODEL semantics, not provider — no map change
                          // needed if the onnx model config value is also 'mxbai-embed-large',
                          // OR the map needs a second key 'mxbai-embed-large-v1' if the onnx
                          // config.embedding.model string differs from the Ollama one — SLICE-1
                          // must pick ONE canonical model string and confirm QUERY_PREFIX_BY_MODEL
                          // resolves it; do not let this silently fall through to '' no-prefix).
};

// NEW top-level block, mirrors `ollama: { baseUrl }` / `azure: { endpoint, ... }`
onnxEmbed?: {
  cacheDir?: string;      // default: `<dataDir>/models/onnx/`
  modelPath?: string;     // explicit local override; takes precedence over download
  numThreads?: number;    // ORT intraOpNumThreads; default: a conservative cap (e.g. min(4,
                           // os.cpus().length)), NOT unbounded — mirrors this repo's existing
                           // NUM_CTX_CAP-style discipline of never letting a background daemon
                           // claim unbounded local resources
};
```

`defaultConfig()` (`config.ts:919`) is **not** changed — stays `{ provider: 'ollama', model:
'mxbai-embed-large', dim: DEFAULT_EMBED_DIM }` (constraint #9, no default flip in v1).

## Contract delta — `EmbedProvider` union widen

```diff
- readonly name: 'ollama' | 'azure-openai';
+ readonly name: 'ollama' | 'azure-openai' | 'onnx';
```

No other field on `EmbedProvider` changes shape. `OnnxEmbedProvider implements EmbedProvider`
follows the exact constructor/method signature of `OllamaEmbedProvider`
(`src/providers/embed/ollama.ts:70-167`): `name = 'onnx' as const`, `model`, `dim`, `queryPrefix`,
`embed(texts, signal?)`, `health()`.

`embed()` cancellation contract (constraint #6, honestly stated): in-process ORT inference is not
cancellable mid-single-inference-call the way an HTTP request is (no `fetch`-style abort
plumbing into the native ORT session run). The provider checks `signal.aborted` **between texts**
in the batch loop (mirroring `OllamaEmbedProvider`'s per-text loop shape) and throws immediately if
set, but a signal that fires mid-inference on a single long text will not interrupt that one
`session.run()` call — it will complete, then the next iteration's check aborts the rest of the
batch. This is a materially different (weaker) cancellation guarantee than the HTTP providers have
and must be documented on the class, not silently implied to match.

`health()` returns `{ok, model, dim, error?}` without a network call (constraint #7): checks the
resolved model artifact path exists and is loadable (session already constructed successfully at
provider-build time, or a lazy first-load succeeds), and that a 1-token smoke inference produces a
vector of the expected `dim` — no HTTP, matching the "no network call" requirement exactly, since
by definition there's no network involved in an in-process session either way (weight *download*
is a one-time first-run event handled separately from `health()`'s per-check contract, see SLICE-2
lazy-load decision).

## Startup preload — lazy first-call, not eager boot

Per `CodexSubscriptionLLMProvider`'s own documented judgment (`providers/index.ts:61-67`: "No
construction-time throw here... so selecting this provider without having run `codex login` yet
doesn't crash daemon boot") — mirror that posture. `OnnxEmbedProvider`'s constructor does **not**
eagerly load the ORT session or trigger a weight download; the session is created and weights
resolved on first `embed()` or `health()` call, memoized thereafter for the process lifetime. This
avoids adding boot latency to every daemon start (including the common case where `provider:
onnx` isn't even selected) and avoids crashing boot if the model artifact hasn't been downloaded /
`modelPath` is misconfigured — that failure surfaces through `health()`/`embedProbe` exactly like a
`codex login`-missing failure surfaces through `CodexSubscriptionLLMProvider.health()` today, not
through a boot crash. Trade-off, stated explicitly: the FIRST real embed call after boot (or after
switching to `onnx` in config) pays session-load + possible download latency inline — acceptable
given `serve.ts`'s existing degraded-start posture (`/health.status`: starting|ok|degraded) already
expects and surfaces exactly this kind of "warming up" state for the embed probe specifically.

## Out-of-scope for v1

- **Default-flip.** Ollama stays the shipped default (`defaultConfig()` unchanged). A default flip
  is a separate decision requiring its own evidence (parity + a real install-friction track record
  across platforms), not bundled into this ADR.
- **GPU execution provider (CUDA/DirectML) for ONNX.** Defeats the VRAM-offload goal; rejected as
  option 4 above. Could be a future *opt-in-opt-in* (operator explicitly wants faster embed at the
  cost of VRAM they've decided they can spare) but is not part of this plan.
- **Non-1024-dim models / different embedding model families** (e.g. `bge-m3`, `bge-large-en-v1.5`)
  on the ONNX path. `QUERY_PREFIX_BY_MODEL` already has a `bge-m3` entry from FEAT-501's evaluation
  work, but wiring a second ONNX model choice is a separate, later slice — v1 is `mxbai-embed-large`
  only, to keep the geometry-parity question to exactly one model.
- **Batch-inference throughput tuning** (e.g. running the ORT session with dynamic batching across
  concurrent `embed()` callers) — v1 processes texts in the same per-text loop shape the two
  existing providers use; a batched-session optimization is a follow-up perf slice, not required
  for correctness.
- **Wizard/`init` flag for provider selection.** v1 requires a manual `config.yaml` edit
  (`embedding.provider: onnx`) — no new `init --embed-provider` CLI flag. Matches constraint #9's
  "opt-in" framing; wizard integration is a follow-up once the parity gate has a recorded outcome.

## Effort estimate vs. the ~2-day/model guess

| Slice | Scope | Estimate |
|---|---|---|
| S1 | Provider skeleton, artifact-resolution (incl. Risk A investigation/fallback), tokenizer wiring, unit tests | 1–1.5 days — the artifact-resolution unknown (Risk A) is the swing factor; if a maintained ONNX export is found quickly this compresses to ~0.5 day, if self-conversion is required it can add a full day |
| S2 | Config surface, factory wiring, lazy-load, doctor probe verification, cross-platform install check | 0.5 day — mostly plumbing following an established 3-provider pattern |
| S3 | Parity verification harness + go/no-go recording | 0.5–1 day — harness code is small, but requires a populated corpus and careful threshold judgment; the retrieval-eval run itself is fast (existing harness) |
| S4 | Docs + switcher guidance | 0.25 day |
| **Total** | | **~2.25–3.25 days** |

Close to the user's ~2-day/model estimate, running slightly over primarily because of Risk A
(artifact sourcing is an unknown, not a known quantity) and because the parity gate (S3) is treated
as a first-class deliverable rather than a quick eyeball check — consistent with this repo's
ADR-015 "canary must measure rate, not existence" discipline, which this ADR explicitly inherits
for the go/no-go threshold rather than a hand-wave "looks about right."

## Build Sequence

| Phase | Files | Change type | Acceptance criteria | Validation command |
|---|---|---|---|---|
| S1 | `src/providers/embed/onnx.ts` (new) · `src/contracts/embed.ts` (union widen) · `tests/providers/onnx-embed.test.ts` (new) | add / modify | Risk A resolved (maintained export located+pinned by revision, or self-convert fallback executed and artifact published) as a BLOCKING criterion, documented in the PR; `OnnxEmbedProvider implements EmbedProvider` with `name: 'onnx'`; `embed(['x'])` returns `Float32Array[1024]` against an injected/stubbed ORT session in unit tests (no live model download in CI, mirroring `ollama-embed.test.ts`'s fake-fetch pattern); dim mismatch throws in the same shape as the other two providers | `bun test tests/providers/onnx-embed.test.ts` |
| S2 | `src/config/config.ts` (union widen + `onnxEmbed` block, NOT default value) · `src/providers/index.ts` (`buildEmbedProvider` onnx branch) · `src/doctor/probes/embed-probe.ts` (verify-only, likely zero-diff) · `tests/providers/onnx-embed.test.ts` (extend) | modify | `config.embedding.provider: 'onnx'` resolves via `buildEmbedProvider` to a working `OnnxEmbedProvider`; ORT session constructed once per daemon boot (lazy-first-call, not per-`embed()`-call — assert via call-count in test); `embedProbe` passes against it; cross-platform install confirmed on win32 at minimum | `bun test tests/providers/ tests/doctor/probes/embed-probe.test.ts` |
| S3 | `scripts/eval/onnx-parity-check.mts` (new) · `docs/research/<date>-onnx-embed-parity.md` (new, findings) | add | N≥200-sample cosine-similarity pre-gate reported (mean/min/p5); `tests/eval/retrieval-eval.test.ts` re-run with `OnnxEmbedProvider` swapped in, compared against existing recall@10 ≥ 0.9 / NDCG@10 ≥ 0.7 floors; RECALL-S1 query-prefix asymmetry re-verified on the ONNX path; explicit go/no-go recorded per the thresholds in "Geometry-parity risk" above | manual run; numbers recorded in the research doc (no CI gate — matches `eval:locomo:*`'s existing "heavy, not CI-gated" precedent) |
| S4 | `docs/providers.md` · `CLAUDE.md` (embedding section) · `docs/embed-dim-migration.md` (cross-reference only) | modify | opt-in config documented; weight download-on-first-run + offline `modelPath` override documented; explicit switch procedure for EXISTING installs (`reembed-dim --dim 1024` after editing `config.yaml` — confirmed zero-new-code per Patterns Found above) documented; explicit "fresh install, no reembed needed" path documented separately from the existing-install path | none (doc-only) |

## Open trade-offs for the user/dispatcher to decide

1. **Artifact source for the ONNX weights** (self-hosted vendored copy vs. relying on a
   third-party HF mirror staying available) — affects long-term install reliability;
   recommend vendoring to a repo-controlled location once S1 identifies the export, rather than
   depending indefinitely on an unaffiliated community mirror.
2. **`numThreads` default** — needs a measured value, not a guessed one; propose S2 include a
   simple before/after CPU-usage note even though full perf tuning is out-of-scope.
3. **Whether S3's go/no-go, if it passes, immediately unlocks a "no reembed needed" claim for
   existing installs, or whether that always needs a second, explicit sign-off ADR** — this ADR's
   position is the latter (safer default), but the dispatcher may decide the S3 evidence bar is
   sufficient to fold that decision into this same ADR's acceptance instead of spinning up a new one.
