# ADR-018 — ONNX embedder decision-maker benchmark: measured results

Status: **MEASURED, complete run.** Every number below came out of a real, full
execution of `scripts/eval/onnx-embedder-benchmark.mts --parity-n 200` on this
worktree (`worktree-agent-aeacd08f70ccb11af`, based on SLICE-5 commit `3ac3f00`
— `ONNX_MODEL_REGISTRY` + CLS/mean pooling + bge-m3). No row was skipped, no
number was estimated or backfilled — see "What did NOT run as originally
planned" below for the one methodology deviation (English retrieval), which
was a real environment constraint hit live, not a shortcut taken by choice.

Raw output: `scripts/eval/results/onnx-embedder-benchmark.json`. Harness:
`scripts/eval/onnx-embedder-benchmark.mts`. Chinese fixture:
`contracts/fixtures/eval/chinese-retrieval-handauthored.json`.

## The answer, up front

**Ship `onnx-mxbai-cls-q8` (CLS pooling, q8 quantization) as the free,
no-re-embed drop-in replacement for an existing `ollama` + `mxbai-embed-large`
install.** Mean cosine parity vs the live Ollama baseline is **0.98944** over
N=200 real distilled texts, with **zero of 200 pairs below the 0.98 ADR-018
gate** (min=0.98306). This clears the GO threshold outright — no
`reembed-dim`-style migration needed for an operator switching providers at
the same model. CPU latency (~35-41ms/embed) is close to Ollama's own
(~25-29ms), comfortably inside the "must not bottleneck ingest" bar.

**fp32 buys near-perfect parity (0.99999 mean) at ~2.5-3.5x the latency and
~4x the disk/RAM footprint — not worth it, since q8 already clears the gate.**

**bge-m3 wins decisively on Chinese retrieval (1.000/1.000 vs mxbai's
0.950/0.799 recall/NDCG@10) with zero measured English cost on this
benchmark's fixture (ties mxbai exactly, 1.000 recall / 0.912 NDCG both)** —
but it is a **different embedding space**, not comparable via the parity
metric, and switching an existing mxbai install to it requires a full
re-embed, not a drop-in swap.

## The critical isolation: pooling was the bug, not quantization

This is the single most important comparison in the whole matrix:

| Variant | mean cosine | min | pairs below 0.98 |
|---|---|---|---|
| `onnx-mxbai-**mean**-q8` | 0.94884 | 0.92527 | **200/200** |
| `onnx-mxbai-**cls**-q8` | 0.98944 | 0.98306 | **0/200** |
| `onnx-mxbai-cls-**fp32**` | 0.99999 | 0.99999 | 0/200 |

Same quantization (q8) in the first two rows — the ONLY variable is pooling
strategy — and it is the entire difference between a hard NO-GO (every single
pair fails the gate) and a clean GO (every single pair passes). This confirms
SLICE-5's correction (mxbai-embed-large-v1's own model card: CLS is its
*default*, not mean — ADR-018's original text had this backwards, see
`docs/research/20260715-bge-m3-onnx-model-matrix.md`'s Contradictions
section) was the right fix, and quantifies it: mean pooling was never going
to clear the gate at any dtype, and fp32's gain over q8 (0.98944 → 0.99999,
+0.0106) is a rounding error next to pooling's (0.94884 → 0.98944, +0.0406).

## Full measured matrix

| id | provider | model | pooling | dtype | health |
|---|---|---|---|---|---|
| ollama-mxbai (BASELINE) | ollama | mxbai-embed-large | native | — | OK |
| onnx-mxbai-cls-q8 | onnx | mxbai-embed-large-v1 | cls | q8 | OK |
| onnx-mxbai-mean-q8 | onnx | mxbai-embed-large-v1 | mean | q8 | OK |
| onnx-mxbai-cls-fp32 | onnx | mxbai-embed-large-v1 | cls | fp32 | OK |
| onnx-bge-m3-cls-q8 | onnx | bge-m3 | cls | q8 | OK |

### 1. Parity vs ollama-mxbai (cosine, document-side, no query prefix, N=200)

Corpus: `.eval-data/locomo/runs/fullsuite-ksweep/datadir/memory.sqlite` (real
distilled LoCoMo memory-atom text — priority-(a) source, same corpus
`scripts/eval/onnx-parity.mts` uses).

| id | mean | min | p5 | below-0.98 | verdict |
|---|---|---|---|---|---|
| onnx-mxbai-cls-q8 | 0.98944 | 0.98306 | 0.98446 | 0/200 | **GO** (ADR-018 gate: mean ≥ 0.98) |
| onnx-mxbai-mean-q8 | 0.94884 | 0.92527 | 0.93355 | 200/200 | **NO-GO** |
| onnx-mxbai-cls-fp32 | 0.99999 | 0.99999 | 0.99999 | 0/200 | **GO**, near-bit-identical |
| onnx-bge-m3-cls-q8 | n/a | n/a | n/a | n/a | not applicable — different embedding space, see below |

bge-m3 has no parity row by design: it is a structurally different model
(BAAI XLM-RoBERTa-large-class backbone, not a re-export of the same
mxbai weights), so "cosine similarity vs the mxbai Ollama baseline" measures
nothing meaningful — this was flagged in the dispatch and confirmed correct
by construction, not re-litigated here.

### 2. Latency (CPU, single-embed + batch-of-32)

Measurement caveat (confirmed by reading both provider implementations, not
assumed): **neither `OnnxEmbedProvider.embed()` nor `OllamaEmbedProvider.embed()`
batches internally** — both loop one-text-at-a-time regardless of how many
texts the caller passes in one `embed()` call. "batch-of-32" below is 32
sequential single-text calls under one wall-clock timer, not a true batched
forward pass — a real ORT batching implementation (feeding all 32 through one
session.run() call) would very likely be faster than this number, but that is
future work, not what's measured here.

| id | single mean (ms) | batch32 total (ms) | ms/embed in batch |
|---|---|---|---|
| ollama-mxbai (BASELINE) | 25.4 | 930 | 29.1 |
| onnx-mxbai-cls-q8 | 34.6 | 1313 | 41.0 |
| onnx-mxbai-mean-q8 | 46.0 | 1234 | 38.6 |
| onnx-mxbai-cls-fp32 | 88.8 | 3213 | 100.4 |
| onnx-bge-m3-cls-q8 | 36.2 | 1195 | 37.3 |

q8 ONNX (either pooling) runs at roughly **1.3-1.8x Ollama's own single-embed
latency** on CPU — a real but small cost for moving inference off the GPU
entirely, well within "must not bottleneck ingest." fp32 is **~3.5x Ollama's
latency** — a real cost, and unnecessary given q8 already clears the parity
gate. (cls-q8 vs mean-q8 single-latency numbers, 34.6ms vs 46.0ms, are close
enough to be measurement noise across two ~1-2s health-check-triggered
sessions rather than a real pooling-cost difference — CLS-slice and
mean-reduce are both cheap post-processing steps relative to the transformer
forward pass; do not read a pooling latency conclusion into this table.)

### 3. English retrieval (ADR-005 fixture, N=11 queries / 12 atoms)

**Methodology deviation from the original plan, encountered live, not chosen
in advance:** the plan was to run `runRetrievalEval` (the real FTS+vector
hybrid engine) via `openDb(':memory:')`. That throws under `bun` on this
Windows box —

```
'better-sqlite3' is not yet supported in Bun.
Track the status in https://github.com/oven-sh/bun/issues/4290
```

— because `src/storage/db.ts` unconditionally imports
`better-sqlite3-multiple-ciphers`, matching CLAUDE.md's own documented
footgun ("better-sqlite3 is NOT supported under Bun on Windows"). Notably,
`scripts/eval/feat-501-embed-model-ab.mts`'s own header comment claims `bun
scripts/eval/feat-501-embed-model-ab.mts` as its usage line while also
importing `openDb` — that combination was evidently never actually exercised
on this OS/bun pairing, or FEAT-501 was run under `node` despite the header.
Flagging as a real, reproducible finding for whoever owns eval tooling next,
not fixed here (out of this benchmark's write scope, which is measurement,
not repo-wide eval-harness hardening).

**Fix used instead:** the same pure-cosine top-k ranking as the Chinese
metric (embed every fixture atom as a "doc," embed every query with the
provider's query-side prefix applied exactly as `src/search/search.ts` does,
rank by cosine, score with `recallAtK`/`ndcgAtK` from `src/eval/metrics.ts` —
the identical metric functions the ADR-005 CI gate uses). This isolates
embedding-space quality specifically, which is this benchmark's only
question — at the cost of not exercising the real engine's `as_of`/entity
filters (fixture queries q6, q9, q10, q11 depend on those; they are scored
here on raw semantic similarity only, not the bitemporal/entity-aware
pipeline those specific queries were designed to exercise). The fixture is
also small (11 queries) — same caveat FEAT-501's own doc flagged for this
identical corpus.

| id | recall@10 | NDCG@10 |
|---|---|---|
| ollama-mxbai (BASELINE) | 1.000 | 0.912 |
| onnx-mxbai-cls-q8 | 1.000 | 0.903 |
| onnx-bge-m3-cls-q8 | 1.000 | 0.912 |

All three land within a hair of each other and all hit perfect recall — the
fixture is small and largely saturated (same conclusion FEAT-501's A/B
reached on this exact corpus). Read this as "no regression, not a
discriminating signal," not as proof of English-quality equivalence at
scale.

### 4. Chinese retrieval (hand-authored fixture, N=20 queries / 25 docs)

**NOT C-MTEB.** `contracts/fixtures/eval/chinese-retrieval-handauthored.json`
is a hand-authored fixture built for this benchmark — 25 short Chinese
sentences spanning weather, transit, finance, recipes, health, travel,
sports, retail, and 5 topically-adjacent distractors (e.g. a second typhoon
doc, a second phone-battery doc) specifically to create real discrimination
pressure, not softball 1:1 matches. No path to fetch/subsample a real
C-MTEB/T2Retrieval/DuRetrieval dataset from Hugging Face was available in
this build session (see `docs/research/20260715-bge-m3-onnx-model-matrix.md`
§5, which already flagged this exact gap and recommended the subsample
approach as future work). Treat these numbers as a **directional signal**,
not a published-benchmark result — the fixture's own `note` field says the
same thing.

| id | recall@10 | NDCG@10 |
|---|---|---|
| onnx-mxbai-cls-q8 | 0.950 | 0.799 |
| onnx-bge-m3-cls-q8 | 1.000 | 1.000 |

bge-m3 gets every single query's gold document into the top-10 with perfect
ranking; mxbai misses one of twenty and ranks several golds lower when it
does find them (NDCG 0.799 vs 1.000 — a real ranking-quality gap, not just a
recall miss). Directionally confirms the market-research doc's finding
(mxbai is English-only-tagged, bge-m3 is explicitly multilingual-trained)
with this repo's own first-party measurement, on a fixture built specifically
to make the two models work for it rather than a token 1:1 softball set.

### 5. Footprint (weight file size + isolated-subprocess RSS)

RSS measured in a fresh `bun` subprocess per row (`--footprint-worker`
mode) — `preload()` + one warmup `embed()` call, `process.memoryUsage().rss`
delta from before provider construction to after — so one row's loaded ORT
session never inflates another row's reading. This is a **process-level RSS
snapshot after one warmup call**, not a peak-during-load or steady-state
measurement under real ingest load; treat as approximate.

| id | file size (bytes) | file size (approx) | RSS delta (bytes) | RSS delta (approx) |
|---|---|---|---|---|
| onnx-mxbai-cls-q8 | 336,983,163 | ~321 MB | 445,763,584 | ~425 MB |
| onnx-mxbai-mean-q8 | 336,983,163 (same file as cls-q8) | ~321 MB | 437,747,712 | ~417 MB |
| onnx-mxbai-cls-fp32 | 1,336,854,282 | ~1.24 GB | 1,422,024,704 | ~1.36 GB |
| onnx-bge-m3-cls-q8 | 569,694,530 | ~543 MB | 1,022,451,712 | ~975 MB |

bge-m3's RSS-to-file-size ratio (~1.8x) is notably higher than mxbai
q8's (~1.3x) — consistent with bge-m3 being a larger-parameter backbone
(~568M params vs mxbai's ~335M, per
`docs/research/20260715-bge-m3-onnx-model-matrix.md`), so more activation/
buffer overhead at inference time even at the same q8 quantization tier.

## Recommendations

**(a) English-only users wanting VRAM offload:**
`provider: onnx`, `model: mxbai-embed-large-v1`, `dtype: q8`, `pooling: cls`
(the `ONNX_MODEL_REGISTRY` default — no override needed beyond selecting
`onnx`). Free drop-in for an existing `ollama` + `mxbai-embed-large` install:
0.98944 mean parity, zero of 200 pairs below the 0.98 gate, ~321MB on disk,
~425MB RSS, latency close to the Ollama baseline. **No re-embed required.**

**(b) Chinese/multilingual users:**
`provider: onnx`, `model: bge-m3`, `dtype: q8`, `pooling: cls` (also the
registry default for bge-m3). Decisive Chinese retrieval win (1.000/1.000 vs
mxbai's 0.950/0.799) with no measured English cost on this benchmark's
fixture. **This is a different embedding space from mxbai — switching an
existing mxbai-based install to bge-m3 requires a full re-embed
(`reembed-dim`-equivalent procedure), it is NOT a drop-in swap** the way (a)
is. New installs choosing multilingual support from day one pay no
migration cost at all.

**fp32 is not recommended for either profile** — q8 already clears the
parity gate for mxbai (there is no bge-m3 fp32 first-party quantized
alternative to compare against in this matrix), and fp32 costs ~2.5-3.5x the
latency and ~4x the disk/RAM footprint for a parity gain (0.98944 →
0.99999) that does not change the GO/NO-GO decision.

## Limitations / follow-ups

- English retrieval ran via pure-cosine ranking, not the real hybrid search
  engine, due to a live `better-sqlite3`-under-`bun`-on-Windows failure (see
  §3 above) — worth a real fix (either an eval-tooling `node` escape hatch for
  `openDb`-based evals, or documenting the constraint on every script that
  imports `src/storage/db.js` under a `bun scripts/eval/...` usage line) as a
  follow-up, not attempted here.
- Chinese fixture is hand-authored, not C-MTEB — a genuine C-MTEB subsample
  (per the market-research doc's own §5 recommendation) would carry more
  external validity for a publishable claim.
- Neither embed provider batches internally — the "batch-of-32" latency
  numbers are 32 sequential calls, not a real batched forward pass. A true
  ORT batch-inference path (single `session.run()` over a padded batch) is
  unexplored and could materially change the ONNX-vs-Ollama latency
  comparison in ONNX's favor; out of scope here (this benchmark measures
  what ships today, not what could be built).
- Footprint RSS is a single post-warmup snapshot per isolated subprocess, not
  a steady-state or peak-under-load measurement.
