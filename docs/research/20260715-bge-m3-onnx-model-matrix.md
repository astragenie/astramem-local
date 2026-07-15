# bge-m3 as a second in-process ONNX embedding model — de-risk research

Status: **read-only market/artifact research, no code changed.** Answers the six
questions dispatched for de-risking a hypothetical SLICE-5 (bge-m3 alongside the
ADR-018 SLICE-1 `mxbai-embed-large` ONNX provider, `feat/onnx-embed-provider-s1`
branch, not yet on `main`). All URLs below were fetched live on 2026-07-15.

## Answer

**Xenova/bge-m3** (pinned at commit `4de13258303883538bd53b696b452bf8099f0858`,
`dtype: 'q8'` → `onnx/model_quantized.onnx`, ~570 MB) is the correct artifact —
it is the only bge-m3 ONNX export tagged `library_name: transformers.js` and it
carries ~430x the monthly downloads of the next-largest community alternative.
bge-m3 dense retrieval is confirmed 1024-dim and **CLS-token pooling**
(`last_hidden_state[:, 0]`, then L2-normalize) — **not** mean pooling — so
transformers.js's `pipeline('feature-extraction', {pooling: 'cls', normalize:
true})` is the correct out-of-the-box call, per Xenova/bge-m3's own model-card
usage example, but the current SLICE-1 provider hardcodes mean-pooling only
(`poolMeanNormalize`), so wiring bge-m3 requires making pooling strategy a
per-model parameter, not a config toggle. **This makes SLICE-5 a MEDIUM
provider-refactor, not a small config change** — see §7 below. No published
numeric parity check between the Xenova ONNX export and FlagEmbedding's
PyTorch reference was found (knowledge gap). A genuinely surprising secondary
finding: mxbai-embed-large-v1's own model card states CLS pooling is **its**
default too (mean is offered as an alternative) — contradicting ADR-018's
text and the current SLICE-1 hardcode; flagged under Contradictions, out of
this dispatch's scope to fix.

## Evidence

| Claim | Source (URL) | Accessed | Tier | Consensus |
|---|---|---|---|---|
| bge-m3 dense output dim = 1024 | https://huggingface.co/BAAI/bge-m3 | 2026-07-15 | T2 | strong |
| bge-m3 needs no query instruction prefix ("no longer requires adding instructions to the queries") | https://huggingface.co/BAAI/bge-m3 | 2026-07-15 | T2 | strong (matches FEAT-501's own prior finding, `docs/research/20260714-feat-501-embed-model-ab.md`) |
| bge-m3 dense pooling = CLS token: `last_hidden_state[:, 0]`, default `sentence_pooling_method="cls"` | https://bge-model.com/_modules/FlagEmbedding/finetune/embedder/encoder_only/m3/modeling.html | 2026-07-15 | T1 (BAAI's own FlagEmbedding source, mirrored on the official BGE docs site) | strong |
| BGE-M3 tutorial states dense embedding = "normalized hidden state of the special token [CLS]" | https://bge-model.com/tutorial/1_Embedding/1.2.4.html | 2026-07-15 | T2 (official BAAI docs) | strong |
| `BGEM3FlagModel`/`BGEM3EmbeddingFunction` default `normalize_embeddings=True`, `return_dense=True` | https://milvus.io/api-reference/pymilvus/v2.5.x/EmbeddingModels/BGEM3EmbeddingFunction/BGEM3EmbeddingFunction.md | 2026-07-15 | T3 (Milvus SDK docs, third-party wrapper of the official model) | moderate |
| `Xenova/bge-m3` exists, `library_name: transformers.js`, tags include `base_model:quantized:BAAI/bge-m3`, MIT license | https://huggingface.co/api/models/Xenova/bge-m3 | 2026-07-15 | T2 (community export, but by the transformers.js maintainer org) | strong |
| `Xenova/bge-m3` HEAD commit sha = `4de13258303883538bd53b696b452bf8099f0858` | https://huggingface.co/api/models/Xenova/bge-m3 | 2026-07-15 | T1 (raw HF API response) | strong |
| `Xenova/bge-m3` 198,449 downloads/month | https://huggingface.co/Xenova/bge-m3 | 2026-07-15 | T2 | strong |
| `Xenova/bge-m3` model card usage example: `pipeline('feature-extraction', 'Xenova/bge-m3')` then `extractor(texts, {pooling: 'cls', normalize: true})` | https://huggingface.co/Xenova/bge-m3 | 2026-07-15 | T2 | strong |
| `Xenova/bge-m3` `onnx/model_quantized.onnx` = 569,694,530 bytes (~570 MB, q8); `model_fp16.onnx` = ~1.13 GB; `model.onnx`+`model.onnx_data` (fp32) = ~2.27 GB total | https://huggingface.co/api/models/Xenova/bge-m3?blobs=true and https://huggingface.co/Xenova/bge-m3/tree/main/onnx | 2026-07-15 | T1 (raw file sizes) | strong |
| `Xenova/bge-m3` was actively updated to transformers.js v3.4 packaging (`@huggingface/transformers`) on 2025-03-06, most recent commit | https://huggingface.co/Xenova/bge-m3/commit/39a50ffa2f27e804ff4070689c5503830f6c31ed | 2026-07-15 | T1 | strong |
| `BAAI/bge-m3` (first-party) DOES ship its own `onnx/` subfolder (`onnx/model.onnx` + `onnx/model.onnx_data`, fp32 only, ~2.27 GB, no quantized variant) — commit sha `5617a9f61b028005a4858fdac845db406aefb181` | https://huggingface.co/api/models/BAAI/bge-m3 and https://huggingface.co/BAAI/bge-m3/tree/main/onnx | 2026-07-15 | T1 | strong |
| Alternative community exports exist but are far less used: `aapot/bge-m3-onnx` (433 dl/mo, `library_name: transformers`, no transformers.js tag), `philipchung/bge-m3-onnx` (163 dl/mo), `hotchpotch/vespa-onnx-BAAI-bge-m3-only-dense` (38 dl/mo, dense-only, Vespa-oriented) | https://huggingface.co/api/models/aapot/bge-m3-onnx, https://huggingface.co/api/models/philipchung/bge-m3-onnx, https://huggingface.co/api/models/hotchpotch/vespa-onnx-BAAI-bge-m3-only-dense | 2026-07-15 | T2 | strong (all three independently corroborate Xenova is the dominant option) |
| No numeric ONNX-vs-PyTorch parity report found for `Xenova/bge-m3`; a requester ("michaelfeil") said "I'll verify export accuracy and submit it here" but never posted results in the thread | https://huggingface.co/BAAI/bge-m3/discussions/12 | 2026-07-15 | T4 (unresolved community thread) | single_source / unresolved |
| `mixedbread-ai/mxbai-embed-large-v1`'s own model card: "The model works really well with cls pooling (default) but also with mean pooling"; Python helper signature `def pooling(outputs, inputs, strategy: str = 'cls')`; its own transformers.js example uses `{pooling: "cls"}` | https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1 (fetched twice, two URL forms, consistent both times) | 2026-07-15 | T2 (official model card) | strong — **contradicts ADR-018's "mxbai-embed-large-v1's own model card specifies mean pooling" text and the shipped SLICE-1 `poolMeanNormalize`-only hardcode** |
| `mxbai-embed-large-v1` is tagged/trained English-only; no multilingual claim on its own card | https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1 | 2026-07-15 | T2 | strong |
| One reproducible, code-published English-only RAG benchmark (Paul Graham essays, 400 Qs, top-k retrieval accuracy) found bge-m3 72% vs mxbai-embed-large 59.25% | https://www.tigerdata.com/blog/finding-the-best-open-source-embedding-model-for-rag | 2026-07-15 | T3 (vendor blog, but methodology quoted + code linked, single source) | single_source |
| General MTEB/community consensus: mxbai and nomic (English-focused lightweight models) "score near zero on cross-lingual tasks"; bge-m3 explicitly multilingual, 100+ languages, MTEB overall ~63.0 | web search aggregation across multiple 2026 "best embedding model" roundups (see Trend read below) | 2026-07-15 | T4 (aggregator blog consensus, not one authoritative benchmark) | moderate (multiple independent blogs agree, none is a controlled head-to-head study) |
| C-MTEB `T2Retrieval`: Chinese, Apache-2.0, dev split ~22.8K queries / ~118.6K docs, 159 MB | https://huggingface.co/datasets/mteb/T2Retrieval | 2026-07-15 | T2 | strong |
| C-MTEB `CmedqaRetrieval`: Chinese medical QA, ~100K corpus / ~4K queries, 61.7 MB | https://huggingface.co/datasets/mteb/CmedqaRetrieval | 2026-07-15 | T2 | strong |

## Contradictions

- **mxbai-embed-large-v1 default pooling**: ADR-018 (`docs/adr/ADR-018-onnx-embedding-provider.md`)
  and the shipped SLICE-1 code (`poolMeanNormalize`, `feat/onnx-embed-provider-s1` branch)
  assert/assume mean pooling is mxbai's correct/native strategy. mxbai's own HF model
  card (T2, fetched twice) states CLS pooling is its **default**, with mean offered
  as a secondary supported strategy — resolution: **the model card wins** (T2 > an
  ADR's unverified claim, which the ADR itself flagged as "Low confidence... unverified
  in this ADR" for the artifact question, though not for this specific pooling claim).
  This does not mean SLICE-1's mean-pooling choice is provably *wrong* for retrieval
  quality (the card says mean "also" works), but it does mean the ADR's factual claim
  about what mxbai's card "specifies" is inaccurate, and it reinforces that pooling
  strategy is inherently a per-model property — relevant context for SLICE-5's design,
  not a fix requested or made here (out of this dispatch's write scope). Flagging for
  the dispatcher's awareness, not re-litigating SLICE-1.
- **Best mxbai-vs-bge-m3 English retrieval comparison**: single T3 source (tigerdata.com)
  reports bge-m3 beating mxbai even on English-only text (72% vs 59.25%) — no second
  independent benchmark corroborates this specific number pair. Resolution:
  `requires_further_research` — treat as a directional signal (bge-m3 competitive-or-better
  even on English), not a settled fact, and note this repo's own FEAT-501 in-process A/B
  found the two models byte-identical on the small ADR-005 fixture (inconclusive, not
  contradictory — different, non-discriminating test).

## Trend read

- direction: bge-m3-family and multilingual dense embedders are the dominant open
  Chinese/multilingual embedding choice as of 2026 aggregator roundups; Qwen3-Embedding
  is cited as outperforming bge-m3 specifically on Chinese/MMTEB in at least one source
  (Qwen3-Embedding-0.6B: 64.33 vs bge-m3's 59.56 on MMTEB per one aggregator blog) — a
  newer, unevaluated-in-this-repo alternative worth a future look, not evaluated here
  (out of the six dispatched questions).
- rate: not independently quantifiable from the sources gathered (T4 aggregator
  consensus, not a tracked metric).
- drivers: BAAI's (Beijing Academy of AI) explicit multilingual training investment;
  mxbai (mixedbread.ai) has stayed English-focused per its own card, with a separate
  "Omni" model line (unverified, only glancingly mentioned) for multilingual/multimodal.
- forecast: not attempted — this question is artifact-selection, not market-trend, and
  the trend evidence available is weak (confidence: low).

## Knowledge gaps

- **No numeric ONNX-export-vs-PyTorch-reference parity measurement exists publicly**
  for `Xenova/bge-m3` (the BAAI/bge-m3 discussion thread ends with a promise, never
  fulfilled in-thread) — this repo would be the first to actually measure it. Directly
  maps onto ADR-018's own "Risk B" verification plan (cosine-similarity pre-gate +
  retrieval-eval floors), which SLICE-5 would need to run exactly like SLICE-3 does for
  mxbai, with its own go/no-go thresholds — do not assume Xenova's conversion is
  parity-clean just because it's the most-downloaded option.
- **No direct, controlled mxbai-vs-bge-m3 English+Chinese head-to-head benchmark
  exists** — the closest found (tigerdata.com) is English-only, single-source, and a
  vendor blog (T3). The "bge-m3 wins on Chinese" claim rests on (a) bge-m3 being
  explicitly multilingual-trained and mxbai being explicitly English-only-tagged
  (both T2, strong), plus (b) aggregator-blog consensus that English-only models
  "score near zero" cross-lingually (T4, moderate, not independently verified against
  a specific benchmark run). **This repo would need to run its own eval (per §5/§7
  below) to have a first-party number**, not cite a market claim as settled fact.
- **`@huggingface/transformers` version compatibility not checked against this repo's
  installed version.** Xenova/bge-m3's `config.json` was last touched 2025-03-06 for
  "transformers.js v3.4" packaging; verify against whatever `@huggingface/transformers`
  version SLICE-1 actually pinned in `package.json` before assuming zero-friction load —
  not verified in this research pass (would require reading the branch's `package.json`,
  which was out of scope for this dispatch's web-research focus, though trivially
  checkable by the SLICE-5 builder).
- **BAAI/bge-m3's own first-party `onnx/` export was not load-tested** — this research
  only confirmed its existence and file layout (fp32 only, 2.27 GB, no quantized
  variant) via the HF API; whether `@huggingface/transformers` can load it directly by
  pointing `hfModelId: 'BAAI/bge-m3'` (its onnx/model.onnx path structurally matches
  transformers.js's expected `<repo>/onnx/model.onnx` convention) was not tested. If
  true, this would remove the "community export" trust concern entirely at the cost of
  a much larger required download (2.27 GB vs Xenova's 570 MB q8) and no quantization
  choice. Worth a cheap follow-up load-test before committing to Xenova's fork.
- **Chinese eval harness does not exist in this repo today** — §5 below recommends an
  approach, not a shipped fixture; building it is new work, not a data-gathering
  exercise this research pass could complete.

## Confidence

medium — the artifact/dim/pooling/prefix questions (§1-4) are answered with strong T1/T2
evidence and internally consistent across independent sources (BAAI's own FlagEmbedding
source code, the official BGE docs site, and Xenova's model card all agree on CLS
pooling). The market/prior-art question (§6) and the eval-set recommendation (§5) rest
on thinner, largely T3/T4 evidence and this repo's own judgment, not a settled published
number — hence not "high."

---

## 1. ONNX artifact recommendation

| Candidate | Exists | transformers.js-tagged | Downloads/mo | Best dtype file | Trust assessment |
|---|---|---|---|---|---|
| **`Xenova/bge-m3`** (recommended) | yes | yes (`library_name: transformers.js`) | 198,449 | `onnx/model_quantized.onnx` (q8, 569,694,530 bytes ≈ 570 MB) | Maintained by the transformers.js maintainer org itself (Xenova = Joshua, the library's original author, now folded into `huggingface/transformers.js`); explicitly derived `base_model:quantized:BAAI/bge-m3`; most recent commit (2025-03-06) was a packaging update to the current `@huggingface/transformers` name, showing ongoing maintenance, not an abandoned one-off conversion |
| `BAAI/bge-m3` first-party `/onnx` subfolder | yes | no (`library_name: sentence-transformers`, but its ONNX layout matches transformers.js's expected `onnx/model.onnx` path) | n/a (part of BAAI/bge-m3's 34.9M total downloads) | `onnx/model.onnx` (fp32 only, 2.27 GB total incl. external data file — **no quantized variant published**) | Highest possible trust (first-party BAAI export) but untested with this library and far larger than needed for a CPU comparison path — a viable fallback, not the v1 pick, pending a load test (see Knowledge gaps) |
| `aapot/bge-m3-onnx` | yes | no (`library_name: transformers`) | 433 | `model.onnx` (fp32 only, no quantized variant published) | Individual community author, ~460x fewer downloads than Xenova, no transformers.js packaging |
| `philipchung/bge-m3-onnx` | yes | no (`library_name: transformers`) | 163 | `model.onnx` (fp32 only) | Individual community author, lowest-trust of the viable set |
| `hotchpotch/vespa-onnx-BAAI-bge-m3-only-dense` | yes | no | 38 | `BAAI-bge-m3_quantized.onnx` | Vespa-specific export, dense-only (matches this repo's need for dense-only), but smallest download count and no model-card pooling documentation found |

**Recommendation:** `hfModelId: 'Xenova/bge-m3'`, `revision: '4de13258303883538bd53b696b452bf8099f0858'`
(pinned — never `'main'`, mirroring SLICE-1's own `DEFAULT_ONNX_REVISION` discipline),
`dtype: 'q8'` (resolves to `onnx/model_quantized.onnx`, ~570 MB — larger than mxbai's
337 MB q8 file because bge-m3 is an XLM-RoBERTa-large-class multilingual backbone,
~568M params vs mxbai's 335M BERT-large). All candidates are **community, not
first-party BAAI** exports except the `BAAI/bge-m3/onnx` fp32-only path — this is
consistent with SLICE-1's own precedent of accepting a first-party export when one
exists (mxbai's case) and should be treated with the same "pin by SHA, re-verify before
bumping" discipline SLICE-1 already established, not a lower bar just because it's a
second model.

## 2. Dimension

**Confirmed: 1024.** BAAI's own model card states the dense embedding output is
1024-dimensional. Matches `DEFAULT_EMBED_DIM` — no schema change needed, consistent
with FEAT-501's prior live-Ollama-probe confirmation (`docs/research/20260714-feat-501-embed-model-ab.md`,
"embedding length = 1024").

## 3. Pooling — the central risk, and it is real

**Confirmed: CLS-token pooling, not mean.** BAAI's own `FlagEmbedding` source
(`_dense_embedding`, mirrored on the official `bge-model.com` docs site) shows:

```python
if self.sentence_pooling_method == "cls":
    return last_hidden_state[:, 0]
```

with `"cls"` as the class default, followed by L2-normalize
(`F.normalize(dense_vecs, dim=-1)`, gated by `normalize_embeddings`, which defaults
to `True` in the user-facing `BGEM3EmbeddingFunction`/`BGEM3FlagModel` wrappers per
Milvus's SDK docs). The official BGE-M3 tutorial states this in prose too: "Use the
normalized hidden state of the special token [CLS] as the embedding."

**Does `pipeline('feature-extraction', {pooling: 'cls', normalize: true})` give
parity out of the box?** `Xenova/bge-m3`'s own model card ships exactly this call as
its documented usage example — this is the transformers.js-maintainer's own stated
correct invocation, i.e. **yes, per the artifact's own documentation**, no raw-model
manual CLS extraction should be needed. However: **no third party has published a
numeric verification** that this actually reproduces FlagEmbedding's PyTorch output
(the one person who said they would check, in the `BAAI/bge-m3` discussion thread,
never posted results) — so "the library says this is correct" is T2 (claimed truth),
not T1-verified parity. This repo would need to run its own cosine-similarity pre-gate
(same technique ADR-018's Risk B section already specifies for mxbai) before trusting
it in production.

**Practical consequence for the codebase:** the current SLICE-1 `OnnxBackend.pool()`
signature (`src/providers/embed/onnx.ts` on `feat/onnx-embed-provider-s1`) hardcodes
`poolMeanNormalize` — mean pooling only, dynamically importing `mean_pooling` from
`@huggingface/transformers` and calling `.normalize(2, -1)`. Adding bge-m3 requires a
**second** pool function (`poolClsNormalize`, taking `last_hidden_state`'s
index-0 slice + `.normalize(2, -1)` — transformers.js's `Tensor` type should support a
`.slice`/indexing operation for this, needs confirming against the library's actual
`Tensor` API, not assumed) and a per-model dispatch between the two — this is a real
code-shape change to the `OnnxBackend` interface (`pool()` becomes parameterized by
pooling strategy, not a fixed implementation), not a config-value flip.

## 4. Query prefix

**Confirmed still correct.** BAAI's model card FAQ: "the BGE-M3 model no longer
requires adding instructions to the queries" — matches FEAT-501's prior finding and
the existing `QUERY_PREFIX_BY_MODEL['bge-m3'] = ''` entry (`src/contracts/embed.ts`).
No change needed; re-confirmed against the live card, not assumed stale.

## 5. Chinese eval set recommendation

All standard C-MTEB Chinese retrieval tasks are Apache-2.0-licensed and freely
downloadable, but every one inspected has a large corpus (`T2Retrieval`: ~118.6K docs
/ 22.8K queries, 159 MB; `CmedqaRetrieval`: 100K docs / 4K queries, 61.7 MB) — too
large to wire into an in-process comparison harness the way ADR-005's own fixture
(12 atoms, 11 queries) is small and CI-fast.

**Recommendation: hand-subsample from `C-MTEB/T2Retrieval` (or `DuRetrieval`)** —
pull a small, fixed slice (e.g. 50-100 real queries plus their qrel-linked gold
documents, plus a few hundred distractor documents from the same corpus) into a
static JSON fixture, mirroring this repo's own `contracts/fixtures/eval/corpus.json`
/`queries.json` pattern. This is the lightest option that is still a **real,
professionally-annotated Chinese retrieval benchmark** (not hand-built/synthetic
QA pairs, which would have no external credibility), while staying small enough to
run in-process without a Python `mteb` toolchain dependency (this is a Node/TS repo;
pulling in the `mteb` Python package purely to run one eval would be a heavier
dependency than the fixture-subsample approach). Explicitly **not** recommended:
running the full 22.8K-query `T2Retrieval` dev set in-process — that is
LoCoMo-scale heavy-eval territory (`scripts/eval/locomo/`'s own precedent: heavy,
not CI-gated, run manually), disproportionate for a "does bge-m3 show a Chinese
advantage over mxbai" go/no-go check.

Other options considered and rejected: `CmedqaRetrieval` (medical-domain-narrow,
less representative of general conversational memory content this repo actually
stores); `Mr. TyDi` zh split (small query counts per the original paper, but its
corpus is Wikipedia-scale — large — and its HF page did not surface a quick
per-language file split in this research pass, needs more digging if pursued);
hand-built bilingual QA fixture (rejected — no external validity, exactly what
this repo's own market-researcher framework would flag as `T4`/non-load-bearing).

## 6. Prior art — mxbai vs bge-m3 head-to-head

**No controlled English+Chinese comparison of exactly these two models was found.**
The closest is a single reproducible vendor benchmark (Paul Graham essay corpus,
6,257 chunks, 400 English-only questions, code published) reporting bge-m3 at 72%
overall retrieval accuracy vs mxbai-embed-large at 59.25% — notable because it is
**English-only** and bge-m3 still wins, suggesting the gap is not purely a
Chinese-language artifact, but this is one blog's single run (T3, `single_source`,
not independently corroborated).

For the Chinese-specific question this dispatch actually cares about: no benchmark
run was found comparing mxbai and bge-m3 specifically on Chinese text — the closest
available signal is (a) mxbai's own card confirming English-only training/tagging
with no multilingual claim, and (b) multiple 2026 aggregator "best embedding model"
roundups stating English-focused lightweight models (mxbai, nomic) "score near zero
on cross-lingual tasks" while bge-m3 is explicitly multilingual (100+ languages,
MTEB ~63.0 overall). This is consensus-shaped but not a single authoritative
benchmark — treat the "bge-m3 has a real Chinese advantage over mxbai" premise as
**very likely true given the language-training-scope evidence, but not yet
first-party-measured** by this repo. This repo's own FEAT-501 A/B
(`docs/research/20260714-feat-501-embed-model-ab.md`) was English-only and
inconclusive by design (saturated fixture) — it cannot speak to this question either.

## 7. SLICE-5 sizing verdict

**MEDIUM — a provider refactor, not a small config/pooling-param change.** Three
independent reasons, any one of which alone would already push this past "small":

1. **Pooling must become a per-model strategy, not a fixed function.** SLICE-1's
   `OnnxBackend.pool()` hardcodes mean pooling. bge-m3 needs CLS pooling. This is a
   new code path (`poolClsNormalize`) plus a dispatch mechanism keyed on model
   identity — a real interface change to `OnnxBackend`, `OnnxEmbedProvider`'s
   construction, and probably `config.onnxEmbed`'s shape (a new `pooling` field or
   equivalent), not a value flip in an existing parameter.
2. **New artifact-resolution surface.** No first-party quantized BAAI ONNX export
   exists (only a large fp32-only one) — bge-m3 needs its own
   `DEFAULT_ONNX_HF_MODEL_ID`/`DEFAULT_ONNX_REVISION`/dtype-map constants pointing at
   a *different* community repo (`Xenova/bge-m3`) than mxbai's first-party one,
   doubling the artifact-pinning/re-verification surface SLICE-1 established for one
   model.
3. **A Chinese eval harness does not exist in this repo and must be built from
   scratch** (§5) to actually demonstrate the feature's stated goal ("a
   Chinese-capable embedding option we can COMPARE against mxbai") — this is new
   fixture-authoring and harness-wiring work, not a data lookup. Without it, adding
   bge-m3 ships a second model with no way to prove it does what it was added for.

None of this blocks proceeding — the artifact question (Risk-A equivalent) is
answered cleanly with a pinnable, well-trusted export, and the pooling/prefix/dim
questions are all resolved with strong T1/T2 evidence — but the SLICE-5 estimate
should be built assuming a `OnnxBackend`/config interface change plus new eval
fixture work, in the same size class as SLICE-1 itself (per ADR-018's own S1
estimate: 1-1.5 days), not a quick follow-on.
