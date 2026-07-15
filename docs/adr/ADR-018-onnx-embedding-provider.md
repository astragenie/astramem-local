# ADR-018: In-Process ONNX Embedding Provider

**Status:** Accepted — default as of the S4 slice (this document).
**Date:** 2026-07-15 (S1/S2/S5 implemented 2026-07-15; benchmark run to completion same day;
this write-up captures the decision record that shipped ahead of it — see "Note on
sequencing" below).
**Confidence:** High. The GO/NO-GO decision is backed by a measured benchmark
(`docs/research/20260715-onnx-embedder-benchmark-results.md`), not a projection.

**Context:** The only embedding providers this daemon shipped before this ADR were
`ollama` (local, requires a separate always-on Ollama server + GPU/VRAM budget) and
`azure-openai` (cloud, requires a paid endpoint + network round-trip on every embed
call). Both have a structural cost the daemon's default install doesn't need to pay:
`ollama` competes with the LLM (compaction/extraction) for the same VRAM ceiling this
repo has already hit once (see CLAUDE.md "Ollama 8GB VRAM ceiling"), and `azure-openai`
requires credentials and a network dependency for a task (embedding fixed-size text) that
doesn't need either. `@huggingface/transformers` ships a pure-JS/native-binary path to run
a pinned ONNX export of the same embedding model **in-process, on CPU, with no external
server** — closing that gap without a quality regression, if (and only if) the resulting
vectors are close enough to the existing Ollama baseline to avoid forcing every install
through a `reembed-dim`-style migration.

### Note on sequencing

The provider itself (SLICE-1: skeleton + Risk-A artifact sourcing, SLICE-2: startup
preload + doctor probe, SLICE-5: model registry + CLS-pooling correction + bge-m3) and the
decision-maker benchmark that validates it were both built and run before this formal ADR
document existed — the code and the measurement were the actual decision process; this
document is the record of it, written as part of the S4 "make it default" slice. Every
claim below is checked against the live `src/providers/embed/onnx.ts` /
`src/providers/embed/onnx-registry.ts` source and the benchmark's measured output, not
reconstructed from memory.

## Decision

### 1. In-process ONNX Runtime (CPU execution provider), opt-in-turned-default

`OnnxEmbedProvider` (`src/providers/embed/onnx.ts`) wraps `@huggingface/transformers`'
`AutoTokenizer` + `AutoModel`, loaded lazily (first `embed()`/`health()`/`preload()` call,
never at construction — mirrors `CodexSubscriptionLLMProvider`'s "no construction-time
throw" posture) and pinned to the **CPU execution provider only** — ADR-018 explicitly
rejects GPU EPs for v1, since allocating VRAM for the embedder defeats the entire point of
moving it off Ollama's GPU-resident server. Artifacts are pinned by exact HF commit SHA,
never `'main'`, so an upstream re-export can never silently shift weights under an
already-installed daemon with no version bump to notice by (ADR-015 discipline).

### 2. Model registry: "add a model = one entry, not a provider code change"

`ONNX_MODEL_REGISTRY` (`src/providers/embed/onnx-registry.ts`, moved out of `onnx.ts` in
the S4 cleanup) maps a canonical `config.embedding.model` label to its HF repo, pinned
revision, default dtype, and default pooling strategy. Two models are registered today:
`mxbai-embed-large-v1` (the default, see §3) and `bge-m3` (a documented multilingual
backup, see §5). `config.onnxEmbed.{revision,dtype,pooling}` always overrides a registry
entry's default when set explicitly — the registry supplies defaults, not hardcoded
finals.

### 3. CLS pooling correction (addendum — this ADR's text originally said mean)

**This document's own earlier draft (SLICE-1/2) assumed mean pooling was
`mxbai-embed-large-v1`'s documented default. That was backwards.** The model's own HF card
states: *"works really well with cls pooling (default) but also with mean pooling."*
SLICE-5 corrected `ONNX_MODEL_REGISTRY`'s `mxbai-embed-large-v1` entry to `pooling: 'cls'`
and added `poolClsNormalize` (`onnx.ts`) alongside the pre-existing `poolMeanNormalize` —
both remain fully available via `config.onnxEmbed.pooling`, but the registry default
flipped. `DEFAULT_ONNX_POOLING` (the fallback for any model string *absent* from the
registry) stays `'mean'`, preserving pre-SLICE-5 behavior for an unregistered/custom
model — only the two registered models default to `'cls'`.

The benchmark (§4) later quantified exactly how much this correction mattered: mean
pooling at q8 fails ADR-018's own parity gate on **200 of 200** measured pairs (mean
cosine 0.94884); CLS pooling at the identical q8 quantization passes on **0 of 200**
failing (mean cosine 0.98944). Same weights, same quantization — pooling strategy alone
was the entire difference between a hard NO-GO and a clean GO. See
`docs/research/20260715-bge-m3-onnx-model-matrix.md`'s "Contradictions" section for the
full evidence trail behind the correction itself.

### 4. Startup preload reconciled with "lazy, not eager"

`OnnxEmbedProvider.preload()` (SLICE-2) is a **public, idempotent wrapper around the same
lazy `getBackend()` load** `embed()`/`health()` would trigger on their own first call — it
does not introduce a second code path, and it does not change the class's constructor
contract. `serve.ts` calls it in the **background** (fire-and-forget, non-blocking) only
when `config.embedding.provider === 'onnx'` and the datadir isn't `:memory:`, so the
daemon's port bind is never delayed and a preload failure only WARNs (the next real
`embed()` call retries the lazy load inline — a failed load is never memoized). This is
consistent with, not a contradiction of, "the constructor never eagerly loads the ORT
session or triggers a weight download" — preload is an opt-in, post-construction,
background warm-up a caller can choose to trigger; the provider itself remains lazy by
construction whether or not any caller ever calls `preload()`.

### 5. bge-m3 as a registered backup model (addendum — not the default)

`bge-m3` (`Xenova/bge-m3`, a community ONNX export maintained by the transformers.js
maintainer org itself) is registered in `ONNX_MODEL_REGISTRY` as **a documented backup for
Chinese/multilingual workloads, not the default**. The benchmark measured a decisive
Chinese-retrieval win for bge-m3 over mxbai (recall/NDCG@10: 1.000/1.000 vs 0.950/0.799 —
see §4) with no measured English cost on this benchmark's fixture (ties mxbai exactly:
1.000 recall / 0.912 NDCG both). **bge-m3 is a structurally different embedding space** (a
different backbone, not a re-export of the same mxbai weights) — cosine parity against the
mxbai/Ollama baseline has no meaning for it, and switching an *existing* mxbai-based
install to bge-m3 requires a full re-embed (the `reembed-dim` procedure), it is **not** a
drop-in swap the way onnx-mxbai is for ollama-mxbai. A fresh install choosing bge-m3 from
day one pays no migration cost at all — see the Config guidance section below for exact
selection steps.

## The benchmark verdict (measured, not projected)

Full numbers: `docs/research/20260715-onnx-embedder-benchmark-results.md` (raw output
`scripts/eval/results/onnx-embedder-benchmark.json`, harness
`scripts/eval/onnx-embedder-benchmark.mts`, run to completion 2026-07-15,
`--parity-n 200`, N=200 real distilled LoCoMo memory-atom texts).

**`onnx-mxbai-cls-q8` (CLS pooling, q8 quantization — the registry default) is a free,
no-re-embed drop-in replacement for an existing `ollama` + `mxbai-embed-large` install:**

| metric | result | gate |
|---|---|---|
| mean cosine parity vs ollama-mxbai | **0.98944** | ≥ 0.98 |
| pairs below the 0.98 gate | **0 / 200** | 0 required |
| min / p5 | 0.98306 / 0.98446 | — |
| single-embed latency | ~34.6ms (Ollama baseline: 25.4ms) | must not bottleneck ingest |
| footprint (disk / RSS) | ~321MB / ~425MB | — |

fp32 buys near-perfect parity (0.99999 mean) at ~2.5-3.5x the latency and ~4x the
disk/RAM footprint — **not recommended**, since q8 already clears the gate with zero
failures. This is a **runtime change** (GPU/external-server → CPU/in-process), **not a
quality change**, for an operator already on `ollama` + `mxbai-embed-large`.

## Config guidance

**Selecting a model.** Set `embedding.provider: onnx` in `config.yaml`. `embedding.model`
selects the registry entry — unset defaults to `mxbai-embed-large-v1` (this ADR's
shipped default, English-tuned, CLS+q8). Set it to `bge-m3` for the multilingual backup
(§5). The optional `onnxEmbed` block overrides per-model registry defaults:

```yaml
embedding:
  provider: onnx
  model: mxbai-embed-large-v1   # or: bge-m3
  dim: 1024
onnxEmbed:
  dtype: q8       # 'q8' (default) | 'fp16' | 'fp32'
  pooling: cls    # 'cls' (default for both registered models) | 'mean'
  numThreads: 4   # ORT intraOpNumThreads cap — see the S4 cleanup note below
  # cacheDir / modelPath: optional, offline/air-gapped installs only
```

**Adding a third model is a one-line registry entry**, not a provider code change: add a
key to `ONNX_MODEL_REGISTRY` (`src/providers/embed/onnx-registry.ts`) with its HF repo,
pinned revision, default dtype, and documented pooling strategy, plus a
`QUERY_PREFIX_BY_MODEL` entry (`src/contracts/embed.ts`) if the model needs a query-side
instruction prefix. `tests/providers/embed/onnx.test.ts` pins each entry's shape and
query-prefix against hardcoded literals — a new entry needs its own assertions, not just
provider-level plumbing.

**Migration cost — read this before switching an existing install:**

- **Switching runtime, same model** (`ollama`/`mxbai-embed-large` → `onnx`/
  `mxbai-embed-large-v1`, or vice versa) **does not require a re-embed.** Measured parity
  is ≥ 0.98 cosine for every one of 200 sampled pairs (§ benchmark verdict above) — close
  enough that existing vectors and freshly-onnx-embedded vectors coexist in the same
  index without a quality cliff.
- **Switching models** (e.g. `mxbai-embed-large-v1` → `bge-m3`, on either runtime) **does
  require `astramem-local reembed-dim`** (`docs/embed-dim-migration.md`) — a different
  backbone produces a different embedding space; old and new vectors are not comparable by
  cosine similarity, and leaving them mixed silently corrupts ranking with no error.

**ORT thread cap (S4 cleanup):** `numThreads` defaults to
`Math.max(1, Math.min(4, os.cpus().length - 1))` — bounded, and scaled down on small
boxes rather than a fixed literal that could saturate a 2-core machine. Override via
`onnxEmbed.numThreads` if a specific install needs a different cap.

## Consequences & migration

- **Default flip (S4, separate commit from this document):** `defaultConfig()`'s
  `embedding.provider` moves from `'ollama'` to `'onnx'` for **fresh installs only** — an
  existing `config.yaml` with an explicit `embedding.provider: ollama` (or any other
  value) is never silently overridden; `loadConfigFromDisk`'s deep-merge only replaces
  keys the on-disk file itself sets, and `defaultConfig()` is strictly the fallback base,
  never applied on top of a present key. See the S4 commit for the direct verification of
  this property.
- **`init` wizard:** fresh interactive/non-interactive inits land on `onnx` as the
  pre-selected/default choice; `ollama` and `azure-openai` remain fully selectable.
- **No GPU EP in v1.** CPU-only is a deliberate scope cut, not an oversight — revisit only
  with a measured VRAM/latency case for a GPU EP that doesn't reintroduce the VRAM
  contention this ADR exists to avoid.
- **Cancellation is materially weaker than the HTTP providers.** In-process ORT inference
  has no `fetch`-style mid-call abort; an `AbortSignal` is checked between texts in the
  per-text embed loop, not mid-inference on a single text — documented on `embed()`'s own
  doc comment, not silently implied to match the HTTP providers' guarantee.

## Options considered

1. **In-process ONNX Runtime, CPU EP, pinned-artifact registry (chosen).** No external
   server, no VRAM contention with the LLM, measured drop-in parity for the default model.
2. **Stay on Ollama as the sole local option.** Rejected — keeps competing with the LLM's
   own VRAM budget on this hardware class (already caused one incident, see CLAUDE.md), and
   requires an always-on external server for a task that doesn't need one.
3. **GPU-accelerated ONNX (CUDA/DirectML/CoreML EP).** Rejected for v1 — would reduce
   CPU latency but reintroduces the exact VRAM-contention problem this ADR exists to
   solve; revisit only with a measured case that it doesn't regress that.
4. **Self-convert the model to ONNX at install time instead of a pinned first-party
   export.** Rejected — `mixedbread-ai/mxbai-embed-large-v1`'s own HF repo already
   publishes a first-party ONNX export (confirmed live via the HF API), so a self-convert
   fallback path adds complexity and a second artifact-provenance story with no measured
   benefit.

## References

- `src/providers/embed/onnx.ts`, `src/providers/embed/onnx-registry.ts` — the provider and
  its model registry (S4 cleanup: registry extracted to its own file).
- `docs/research/20260715-onnx-embedder-benchmark-results.md` — the measured GO/NO-GO
  benchmark this ADR's verdict is sourced from.
- `docs/research/20260715-bge-m3-onnx-model-matrix.md` — the CLS-vs-mean pooling
  correction's full evidence trail and the bge-m3 artifact/pooling research.
- `scripts/eval/onnx-embedder-benchmark.mts` — the benchmark harness itself.
- `tests/providers/embed/onnx.test.ts` — provider + registry unit coverage (S4 cleanup:
  the registry's `queryPrefix` drift-guard test rewritten against hardcoded literals,
  since comparing it back to `QUERY_PREFIX_BY_MODEL` — the value's own source — could
  never fail).
- ADR-015 (The Loud Failure Invariant) — the "pin by SHA, never `main`" discipline this
  ADR follows for artifact provenance.
- CLAUDE.md "Ollama 8GB VRAM ceiling" — the incident this ADR's CPU-only, in-process
  design is a structural response to.
- `docs/embed-dim-migration.md` — the `reembed-dim` procedure required when switching
  *models* (not runtimes) on a populated DB.
