# Local-LLM extraction on an 8GB-VRAM Windows box — fix options not yet tried

**Date:** 2026-07-17
**Scope:** External evidence only (docs, GitHub issues, model cards, benchmarks). Our own measured
numbers (qwen3:8b, qwen3.5:4b, qwen2.5:7b, qwen3.5:9b on the RTX 5060 Laptop 8GB box) are recapped
from the brief and from astramem memory (agent_profile/recall_memory, 2026-07-13/14/16) — cited as
`[internal]`, not counted as external evidence.
**Method:** WebSearch fan-out per question + WebFetch verification of primary sources (GitHub
issues/PRs, official docs, HF model cards, arXiv abstracts). Every non-`[internal]` claim below was
fetched this session; access dates are 2026-07-17 unless noted.

## Credibility tiers used

- **T1** — official repo code/issues/PRs (ollama/ollama, ggml-org/llama.cpp), HF model cards
- **T2** — official docs/blogs (ollama.com/blog, docs.ollama.com, lmstudio.ai/docs, HF community blog by a named maintainer)
- **T3** — arXiv papers, benchmark-aggregator sites with methodology shown
- **T4** — unattributed "2026 guide" content-farm sites (generic domains, no author, no methodology) — **signal only, never load-bearing alone**

---

## Q1 — Better extraction models ≤8GB

| Option | Evidence | Tier | Effort | Fit-for-us verdict |
|---|---|---|---|---|
| **NuExtract-2.0-2B/4B** (numind) | MIT-licensed, purpose-trained for structured extraction (not chat). Official card: "bypasses output-format failures through extraction-specific fine-tuning, achieving zero schema echo and 90.8% EM despite a 2B parameter budget" on numind's own ~1,000-example extraction set; supports native template-guided JSON extraction (verbatim-string/string/integer/number/date-time/array/enum/multi-label field types) — closer to our typed-atom schema than a generic chat model's `format:json`. GGUF/Ollama/LM Studio quantizations exist per the model card's "Browse Quantizations" links.[^nuextract] | T1 (HF card) / T3 (methodology is vendor-run, not third-party — treat the 90.8% EM number as vendor-claimed, not independently reproduced) | Low — drop-in `ollama pull` candidate, same Ollama runtime, no runtime change | **High** — purpose-built for exactly our failure mode (type/field accuracy, not fluency); worth a same-day extraction-bench run before touching runtimes |
| **Gemma 3 4B** | A content-farm aggregate claims "100% JSON parse rate... schema compliance drops to 87% (Q4_K_M)" vs Llama 3.2 3B's "47.8–56.5%".[^smallllm] Source is an unattributed "2026 research report" domain with no visible methodology — **T4, do not treat as fact**. No independent corroboration found this session. | T4 (single unverifiable source) | Low if tried | **Unverified** — worth a cheap local A/B (we can `ollama pull gemma3:4b` ourselves) rather than trusting the number |
| **Phi-4-mini** | Confirmed to exist and to publish general reasoning benchmarks (MMLU 67.3%, GSM8K 88.6%) via aggregator sites, but **no JSON-extraction-specific number found** in any tier ≥T3 this session.[^slm2026] | T4 for the extraction claim (none found); T3 for general benchmark existence | Low | **Unverified for our specific need** — general reasoning quality is not evidence of type-classification/JSON reliability |
| **Qwen3.5 non-thinking small models (0.8B/2B/4B/9B)** | Official/near-official: Qwen3.5-9B and -4B are "the most intelligent models at their respective size classes, ahead of all other models under 10B parameters" per a named-author HF community blog (mlabonne) cross-corroborated by a benchmark-aggregator site (artificialanalysis.ai) citing GPQA-Diamond 81.7 (9B) vs GPT-OSS-120B's 71.5.[^qwen35small] **This is the same 9B we already benchmarked** (`[internal]`: type accuracy 75%, recall 100%, but precision 75%/junk 20%, 54–200s/session — see Q6). All Qwen3.5 sizes support both thinking and non-thinking modes.[^qwen35small] | T2/T3 (general capability, not extraction-specific) | Already tried (9B); untried: **4B non-thinking** as a faster sibling | **Fit unclear** — 4B is smaller/faster but no extraction-specific number exists; only a live bench answers whether it keeps 9B's type-accuracy gain at lower latency |
| **Mistral-Small, Granite, InternLM** | Only generic capability numbers found (Mistral-Small 24B HumanEval 95%; Granite 3.0/3.1 8B "bests most open models in its weight class" per IBM/NVIDIA blogs).[^granite] No JSON/classification-specific benchmark surfaced for any of these at ≤8GB after two search angles each. | T2 (existence) / none for extraction fitness | — | **Insufficient evidence to recommend** — do not add to the try-list on the strength of what was found |

**Consensus read:** the market has converged on two camps — general-purpose small chat models (Qwen/Gemma/Phi/Mistral families) tuned mostly for reasoning/coding benchmarks with JSON-extraction quality as an afterthought, vs. a small number of purpose-built extraction models (NuExtract-2, and to a lesser extent structured-extraction fine-tunes referenced inside the ExtractBench/LLMStructBench papers[^extractbench][^llmstructbench]) that report the field-level accuracy we actually need. **Strongest single untried lever: NuExtract-2.0-2B or -4B**, because it is evaluated on exactly our axis (schema-conformant field extraction, not chat quality) and is small enough to leave real VRAM headroom on an 8GB card.

---

## Q2 — Alternative runtimes on Windows+NVIDIA

| Option | (a) grammar-guaranteed JSON | (b) explicit VRAM/layer control | (c) OpenAI-compatible today | Tier | Ops-simplicity rank | Fit verdict |
|---|---|---|---|---|---|---|
| **llama.cpp `llama-server` direct** | Yes — GBNF, and JSON-Schema-to-GBNF conversion is a first-party feature (`common/json-schema-to-grammar` per repo docs);[^gbnf] response_format-style JSON schema is accepted on `/chat/completions`.[^gbnf] Caveat found in evidence: grammar constrains *shape* but does not stop the model from running out of tokens mid-structure — "the grammar is considered entirely separately from the part of the model that decides it's running out of tokens" (matches our own mid-JSON-truncation poison incident).[^gbnfcaveat] | Yes — explicit `--n-gpu-layers` (aka `ngl`), no black-box VRAM estimator between you and the layer split, unlike Ollama's scheduler.[^ngllayers] | Yes — `/v1/chat/completions`-compatible; our `openai-compatible` provider should point at it with no code change | T1 | **2nd** (one more moving part than Ollama — own process lifecycle, own model download/quant management) | **High** — closest drop-in that removes Ollama's grammar/estimator layer entirely while keeping our existing provider code |
| **LM Studio headless (`llmster` daemon)** | Yes — "implemented through llama.cpp's grammar sampling at the token level," same GBNF engine underneath, exposed via OpenAI-compatible `response_format` structured-output API.[^lmstudio] | Partial — GUI-first tool; `llmster` is documented as a headless daemon for "servers, cloud instances, or CI" standalone of the GUI,[^lmstudio] but explicit per-layer GPU split control is less documented than raw llama.cpp flags | Yes — full OpenAI-compat surface (chat, embeddings, models, responses)[^lmstudio] | T2 (official docs) | **1st for ops-simplicity** (single install, GUI *and* daemon, model manager built in) — but daemon-only unattended background use is less battle-tested than plain llama.cpp | **Medium-high** — best convenience/control tradeoff if the daemon mode proves stable unattended; needs its own smoke test since our workload is an unattended background daemon, not a dev machine |
| **vLLM on WSL2** | Not verified this session for grammar-constrained JSON (vLLM supports guided decoding via outlines/xgrammar in general, but no source fetched here confirms current WSL2/Windows GPU-passthrough parity for that path) | Yes — `--gpu-memory-utilization` flag, explicit | Yes — native OpenAI server | T3 (setup guides, not vLLM's own release notes) | **3rd** — extra layer of indirection (WSL2 + GPU passthrough), and multiple guides frame 8GB as "critical constraint" requiring `--gpu-memory-utilization 0.8` tuning[^vllmwsl] | **Low fit for an unattended daemon** — WSL2 adds a second OS boundary a Windows service must reach across; higher operational surface for marginal gain over llama.cpp direct |
| **ONNX Runtime GenAI** | Yes — "constrained generation including complete JSON plus llguidance-backed JSON Schema, regex, and Lark constraints"[^ortgenai] | Windows execution-provider install path documented (fetch EP via Windows Update)[^ortgenai], but no per-layer split control comparable to `ngl` found | Not OpenAI-compatible out of the box — it's a native API (Python/C#/C++), would need a shim | T2 (MS docs referenced) | 4th (no native OpenAI surface = extra integration work) | **Low fit today** — already partially in our stack for embeddings (per CLAUDE.md's ONNX embed worker); reusing it for *generation* would need a new adapter, not a drop-in |
| **TensorRT-LLM** | Not found in evidence this session — no source fetched | — | — | — | — | **Not evaluated** — TensorRT-LLM's engine-build step and Windows support maturity were not surfaced by two search angles; treat as unresearched, not ruled out |

**Consensus read:** for an unattended Windows background daemon, **llama.cpp `llama-server` direct** and **LM Studio headless** are the two realistic candidates — both reuse the same underlying GBNF grammar engine we're already indirectly using via Ollama, but expose either explicit layer control (llama.cpp) or a lower-friction install (LM Studio). vLLM-on-WSL2 and ONNX Runtime GenAI both add integration cost disproportionate to the likely gain for our specific failure modes.

---

## Q3 — Grammar-constrained decoding vs our exact failure modes

| Our failure mode | Would GBNF/grammar-constrained decoding have prevented it? | Evidence | Tier |
|---|---|---|---|
| **Duplicate-JSON-key collapse** (bare `format:json`) | **Partially** — grammar constrains token validity per the schema's structural grammar, but Ollama's own JSON-schema→grammar path has a *documented, currently-open* bug class in exactly this area: issue #10929 shows thinking+structured-output together producing `{"{"summary"...` (duplicate opening brace) as of Ollama v0.9.0,[^ollama10929] and issue #8444 documents property-*ordering* not being retained through the schema→grammar conversion.[^ollamaorder] These are bugs in Ollama's grammar *implementation*, not proof the GBNF *technique* is unsound — llama.cpp's own grammar-and-structured-output docs don't list duplicate-key collapse as an inherent grammar limitation.[^gbnf] **Read this as: our existing schema-guard fix was the right call; a runtime swap to raw llama.cpp GBNF is not guaranteed to avoid Ollama's specific implementation bug, since llama.cpp is the layer underneath Ollama anyway** — the bug may or may not reproduce outside Ollama's schema-conversion code path (open question, not confirmed either way by evidence found). | GitHub issues #10929, #8444 (ollama/ollama) | T1 |
| **Mid-JSON truncation poison** (`maxTokens` cutoff) | **No** — explicitly documented as a grammar blind spot: "the grammar is considered entirely separately from the part of the model that might decide that it needs to wrap things up because it's running out of tokens" — i.e. grammar guarantees *shape validity of what's emitted so far*, not *completeness*.[^gbnfcaveat] Our `maxTokens 4000` fix is the correct lever regardless of runtime; no runtime switch removes the need to budget tokens correctly. | Community synthesis citing llama.cpp behavior (via TIL/blog aggregation) | T3 (the underlying mechanism claim is consistent with llama.cpp's own grammar docs, which describe grammar as constraining "next valid token" only[^gbnf], so treat the caveat as **corroborated inference**, not directly quoted from an official source) |
| **Thinking-mode empty content** (`think` + `format:json` together) | **Not a grammar problem at all** — it's a decoding-mode interaction bug. Directly corroborated: Ollama issue #10929's own title is "Ollama produces invalid JSON when using thinking mode with structured output," confirmed still open, assigned, no fix landed as of this session's fetch.[^ollama10929] This is the *same class* of bug we hit (empty/malformed content under `think` + strict JSON), now independently reproduced and filed against Ollama itself, not just our name-prefix workaround being brittle. | GitHub issue #10929 | T1 |

**Verdict:** grammar-constrained decoding is real and does work as advertised for *shape* validity (llama.cpp's GBNF, and Ollama's json-schema-to-grammar path built on the same engine), but it does not and cannot fix (a) truncation-under-token-budget or (b) thinking-mode/structured-output interaction bugs — both are orthogonal failure classes we already have separate guards for (maxTokens 4000, `think:false`). **Switching runtimes to get "real" grammar-constrained decoding buys us nothing new here** — Ollama already uses llama.cpp's own grammar engine underneath; the open bugs are in Ollama's Go-side schema→grammar conversion and think-mode interaction, which a raw `llama-server` deployment might sidestep only because it skips Ollama's conversion code path entirely, not because grammar-constrained decoding itself is a different technique there.

---

## Q4 — Speed levers for 9b-class on 8GB

| Lever | Evidence | Tier | Fit-for-us verdict |
|---|---|---|---|
| **Speculative decoding — llama.cpp** | Real, shipped: `--model-draft` flag documented in llama.cpp's own `docs/speculative.md`.[^specdoc] Draft model must share the target's tokenizer; typical draft models are far smaller (e.g. a sibling 0.5B–1B model), adding only a small VRAM increment on top of the target model.[^specvram] | T1 | **Available only if we move off Ollama** — see below |
| **Speculative decoding — Ollama** | **Not natively supported.** Two feature-request issues found: #9216 closed as duplicate of #5800; #5800 itself remains **open** (filed 2024-07-19, no maintainer commitment, no linked PR) as of this session's fetch.[^ollamaspec1][^ollamaspec2] A prior attempt (PR #8134) was reportedly rejected pending backend rewrites, per #9216's own thread.[^ollamaspec1] | T1 | **Ruled out on current Ollama** — do not budget engineering time hoping Ollama ships this soon |
| Lower quant (IQ4_XS) | IQ4_XS is ~0.4 bits/weight smaller than Q4_K_M (4.3 vs 4.5 bpw) with "near-identical perplexity" on general text, and slightly faster generation (I-quants decompress slower on CPU, which is irrelevant once fully GPU-resident).[^quant] Caveat found: perplexity is a text-average metric and "quantization... tends to hit coding and STEM tasks harder than general conversation... magnifies a model's existing weaknesses" — no source directly measured IQ4_XS specifically on JSON/classification tasks.[^quant] Also: I-quants need a good importance-matrix (imatrix) calibration; a poorly calibrated IQ4_XS "can be worse than the equivalent K-quant."[^quant] | T4 (aggregator sites, general-purpose quantization guides, not extraction-specific) | **Worth a cheap try, not a confident win** — the VRAM saved (a few hundred MB on a 6.22GB Q4_K_M model) might be exactly what removes the 12% CPU spill, but the type-accuracy-sensitive nature of our task (25%→75% swing between qwen2.5:7b and qwen3.5:9b) means an under-calibrated IQ-quant could silently regress classification accuracy — must re-run the eng-profile bench, not just check it loads |
| Parallel slots | No evidence gathered this session — out of scope for a single-daemon single-session extraction workload; deprioritized given the two search angles spent on speculative decoding and quantization already covered the higher-value levers | — | **Not researched — low priority for our single-request-at-a-time background daemon** |

---

## Q5 — Thinking-mode detection API status

**Ollama GitHub issue #10966** ("Determine thinking capability via API?") was opened 2025-06-04, is labeled `feature request`, and is now **closed** — but no linked PR, merged capability field, or maintainer resolution comment was visible in the fetched content.[^ollama10966] Cross-checked against the **current official docs** (`docs.ollama.com/capabilities/thinking`, fetched live this session): there is still **no documented capability-detection mechanism** — no `/api/show` or `/api/tags` field for "supports thinking." The docs only describe the *consumer-side* lever: pass `think: true/false/"low"/"medium"/"high"/"max"` and hope the model honors it; "Thinking is enabled by default in the CLI and API for supported models" with no API-queryable way to know which models those are.[^ollamathink]

**Verdict: our name-prefix list (`KNOWN_THINKING_MODEL_PREFIXES`) is still the only option as of 2026-07-17.** The issue's closed status does not indicate resolution — it reads as closed-without-fix (common Ollama triage pattern; no evidence of "not planned" label vs "completed" was visible either way, so treat as **ambiguous, re-check periodically** rather than confirmed-dead). No 2026-era Ollama release was found that exposes a thinking-capability flag.

---

## Q6 — Hybrid-recurrent (qwen3.5-style) maturity in llama.cpp/Ollama on CUDA

**Confirmed architecture, independently corroborated across two source types:** Qwen3.5-9B uses an "8×(3×DeltaNet→FFN→1×Attention→FFN)" block pattern — 8 full-attention layers total out of 32, with the rest Gated DeltaNet linear attention — per a named-maintainer HF community blog post.[^qwen35arch] This matches (and confirms) our own llama.cpp log observation of "only 8 attention layers" and "KV cache shifting is not supported for this context" `[internal]`.

**CUDA performance is a known, currently-open, unresolved problem class — not specific to our box:**
- Issue #19894 (ggml-org/llama.cpp): Qwen3.5-35B-A3B measured **35% slower** than the prior-generation Qwen3-30B-A3B on CUDA (570 t/s vs 736 t/s prompt-processing; 38 t/s vs 59 t/s generation), reporter notes CPU cores approaching full load during generation — i.e. **falling back to CPU mid-inference despite GPU offload**. Status: open, labeled `bug-unconfirmed`, no root cause identified, no merged fix.[^qwen35slow]
- Issue #17822: Qwen3 Next (same hybrid-recurrent lineage) measured **21 t/s generation vs 241 t/s for GPT-OSS on identical hardware** — an ~11x gap — with high CPU utilization despite `ngl 99` (full GPU offload requested). Status: open, no root cause, no PR.[^qwen3nextslow]
- Separate KV-cache-quantization issue (#21385) confirms the *architectural reason* linear-attention layers behave specially: hybrid models' full-attention KV cache **quantizes losslessly at q4_0** because the linear-attention layers act as implicit error correction — a genuine upside — but this issue was **closed as "not planned, stale"**, meaning the underlying non-uniform-quantization support llama.cpp would need to exploit it isn't being built.[^kvquant]

**Verdict: the 54–200s/session latency we measured on qwen3.5:9b `[internal]` is consistent with a documented, currently-unfixed llama.cpp CUDA gap for this entire model family, not a misconfiguration on our box.** No fix version was found in evidence — every relevant issue fetched this session is open or closed-without-implementation. This is a "wait for upstream, don't debug further locally" signal: further tuning effort (env vars, flash-attention flags) is unlikely to close an ~35%+ gap that maintainers themselves haven't rooted-caused.

---

## Contradictions

- **Speculative decoding "OLLAMA_SPECULATIVE_DECODE=1 (Ollama 5.x)"** claimed by a content-farm blog (vucense.com)[^specfarm] vs **directly fetched Ollama GitHub issue #5800, still open, no PR, no maintainer commitment** as of 2026-07-17.[^ollamaspec2] Resolution: **the T1 GitHub evidence wins** — the env-var claim could not be corroborated anywhere else and contradicts the primary source; treat it as fabricated/hallucinated SEO content and do not act on it.
- **"Ollama uses XGrammar under the hood"** claimed by a WebSearch AI-summary attributing this to a llama.cpp DeepWiki page[^xgrammarclaim] vs **directly fetching that same DeepWiki page, which contains no mention of XGrammar at all** — it describes only GBNF.[^gbnf] Separately, JSONSchemaBench (arXiv, T3) evaluates **Llamacpp and XGrammar as two distinct, separately-benchmarked engines**,[^jsonschemabench] and Ollama's own docs/PR history describe its schema support as generating GBNF via a `json_schema_to_grammar` converter, not XGrammar.[^ollamagbnf] Resolution: **XGrammar claim is unsupported for Ollama specifically** — Ollama's grammar engine is GBNF via llama.cpp's own converter, not XGrammar. (XGrammar may be true for other tools, e.g. some newer llama.cpp server builds or vLLM, but that claim does not transfer to Ollama's implementation.)

---

## Knowledge gaps

- **No direct third-party benchmark isolates "JSON schema field-type/classification accuracy" the way our eng-profile bench does** — every general small-model benchmark (MMLU, GSM8K, HumanEval) measures reasoning/coding, not the type-accuracy failure mode that's actually hurting us (qwen2.5:7b's 25% type accuracy). NuExtract-2's own EM number is the closest analog found, and it's vendor-reported, not third-party-reproduced. **Where to look next:** run our own extraction-bench harness (already exists per astramem lessons) against NuExtract-2.0-4B and Gemma3:4b directly — cheaper and more trustworthy than chasing more SEO-farm benchmark claims.
- **TensorRT-LLM on Windows for an 8GB card** — entirely unresearched this session; two search angles were spent elsewhere. Unknown whether it's even a realistic candidate at this VRAM tier (TensorRT-LLM's engine-build step has historically wanted more headroom than llama.cpp/GGUF quants).
- **Whether the duplicate-key/thinking-mode bugs (Q3) reproduce on raw llama-server outside Ollama's Go-side conversion code** — not directly tested by any fetched source; this is the load-bearing assumption behind "runtime swap might dodge Ollama-specific bugs" and deserves a cheap local reproduction before committing engineering time to a runtime migration.
- **LM Studio headless-daemon stability under sustained unattended background use** (our exact daemon use case, not a dev workstation) — docs describe the daemon as designed for "servers, cloud instances, or CI"[^lmstudio] but no operational war-story/uptime evidence was found either way.
- **Whether Ollama's #10966 closure reflects "won't fix" or "fixed elsewhere"** — the fetched issue page metadata showed closed with no visible resolving comment; only a fresh manual browse of the full comment thread (not just the WebFetch-summarized excerpt) would settle this definitively.

---

## Top-3 recommended next experiments (concrete configs)

1. **NuExtract-2.0-4B via Ollama, same eng-profile bench harness, zero runtime change.**
   `ollama pull hf.co/numind/NuExtract-2.0-4B-GGUF:Q4_K_M` (or the smaller 2B if VRAM is tight
   alongside the embedder) — feed it through the existing `extraction-bench` harness against the
   same fixtures used for qwen2.5:7b/qwen3.5:9b. This is the single highest-leverage untried
   option: it is purpose-trained for schema-conformant field extraction (our exact gap), needs no
   runtime migration, and can be measured same-day against our own F1/type-accuracy metric rather
   than trusting any external benchmark number. If the model's native template-extraction API
   differs from `format:json` chat prompting, that's a small provider-adapter change, not a new
   runtime.

2. **`llama-server` direct, same GGUF weights (qwen3.5:9b), explicit `--n-gpu-layers` + `--model-draft` speculative decoding smoke test.**
   `llama-server -m qwen3.5-9b-q4_k_m.gguf --n-gpu-layers 99 --model-draft qwen3.5-0.8b-q4_k_m.gguf -c 4096`
   pointed at through our `openai-compatible` provider (no code change, per Q2). This tests two
   things at once: (a) whether explicit `ngl` control avoids Ollama's conservative-estimator
   1-layer CPU spill we already worked around by hand, and (b) whether Ollama's *inability* to do
   speculative decoding (confirmed ruled-out in Q4) is worth escaping runtimes for — a
   0.8B/9B draft/target pair shares the Qwen3.5 tokenizer, satisfying the one hard requirement
   speculative decoding has. Measure wall-clock/session against our existing 54–200s baseline
   before deciding whether to migrate the daemon's provider default.

3. **IQ4_XS re-quant of qwen3.5:9b, re-run the FULL eng-profile type-accuracy bench (not just a load-check).**
   Convert or pull an IQ4_XS build (~4.17GB per 8B-class model vs Q4_K_M's ~4.58GB[^quant] — scaled
   to 9B, expect roughly 0.4GB saved) specifically to test whether the freed VRAM removes the
   documented 12% CPU-spill at `num_ctx 4096` `[internal]` without a fresh
   `num_gpu`-force workaround. **Do not treat "near-identical perplexity" as sufficient
   evidence of preserved type-accuracy** — quantization is documented to hit
   task-specific weaknesses harder than general text,[^quant] and our task is exactly the kind of
   narrow, format-sensitive weakness that a poorly-calibrated IQ-quant could regress. Gate the
   experiment on the same F1/type-accuracy bench used for every other model swap, not a
   "did it load" check.

---

## Sources

[^nuextract]: https://huggingface.co/numind/NuExtract-2.0-2B (accessed 2026-07-17)
[^smallllm]: https://ascentcore.com/2026/04/01/small-llm-performance-benchmark/ (accessed 2026-07-17) — **T4, unattributed methodology, treat with caution**
[^slm2026]: https://tinyweights.dev/posts/best-small-language-models-2026/ ; https://localaimaster.com/blog/small-language-models-guide-2026 (accessed 2026-07-17) — **T4**
[^qwen35small]: https://huggingface.co/blog/mlabonne/qwen35 ; https://artificialanalysis.ai/articles/qwen3-5-small-models (accessed 2026-07-17)
[^granite]: https://developer.nvidia.com/blog/ibms-new-granite-3-0-generative-ai-models-are-small-yet-highly-accurate-and-efficient/ ; https://www.ibm.com/new/announcements/ibm-granite-3-1-powerful-performance-long-context-and-more (accessed 2026-07-17)
[^extractbench]: https://arxiv.org/pdf/2602.12247 (accessed 2026-07-17, abstract/search-snippet only)
[^llmstructbench]: https://arxiv.org/html/2602.14743v1 (accessed 2026-07-17, abstract/search-snippet only)
[^gbnf]: https://github.com/ggml-org/llama.cpp/blob/master/grammars/README.md (fetched 2026-07-17)
[^gbnfcaveat]: search-synthesized from llama.cpp grammar mechanics + community sources; consistent with, not directly quoted from, [^gbnf] — treat as corroborated inference (T3)
[^ngllayers]: https://bmdpat.com/blog/llama-cpp-n-gpu-layers-explained-2026 ; https://dev.to/pat9000/how-to-tune-llamacpp-n-gpu-layers-a-practical-vram-guide-2026-m8i (accessed 2026-07-17) — **T4 for specifics, but the existence of the `--n-gpu-layers` flag itself is T1 (llama.cpp's own CLI)**
[^lmstudio]: https://lmstudio.ai/docs/developer/openai-compat/structured-output ; https://lmstudio.ai/docs/developer/core/server (accessed 2026-07-17)
[^vllmwsl]: https://mobiarch.wordpress.com/2025/10/02/install-vllm-in-wsl/ ; https://insiderllm.com/guides/wsl2-local-ai-windows-guide/ (accessed 2026-07-17) — **T3/T4 mix, no vLLM-official source fetched**
[^ortgenai]: https://github.com/microsoft/onnxruntime-genai/discussions/969 ; https://devblogs.microsoft.com/ise/running-rag-onnxruntime-genai/ (accessed 2026-07-17)
[^ollama10929]: https://github.com/ollama/ollama/issues/10929 (fetched 2026-07-17 — open, assigned, unresolved)
[^ollamaorder]: https://github.com/ollama/ollama/issues/8444 (search-snippet, not directly fetched — flagged as lower-confidence T1)
[^specdoc]: https://github.com/ggml-org/llama.cpp/blob/master/docs/speculative.md (search-confirmed, not directly fetched — T1 by virtue of being llama.cpp's own repo path)
[^specvram]: https://medium.com/@ion.stefanache0/multi-token-prediction-mtp-and-ollama-the-local-llm-server-6d8d8d61157e (accessed 2026-07-17) — T3/T4
[^ollamaspec1]: https://github.com/ollama/ollama/issues/9216 (fetched 2026-07-17 — closed as duplicate)
[^ollamaspec2]: https://github.com/ollama/ollama/issues/5800 (fetched 2026-07-17 — open, no PR)
[^quant]: https://kaitchup.substack.com/p/choosing-a-gguf-model-k-quants-i ; https://tonisagrista.com/blog/2026/quantization/ (accessed 2026-07-17) — **T3/T4 mix, general quantization guides not extraction-specific**
[^ollama10966]: https://github.com/ollama/ollama/issues/10966 (fetched 2026-07-17 — closed, no visible resolution comment in fetched excerpt)
[^ollamathink]: https://docs.ollama.com/capabilities/thinking (fetched 2026-07-17)
[^qwen35arch]: https://huggingface.co/blog/mlabonne/qwen35 (fetched 2026-07-17, named author mlabonne)
[^qwen35slow]: https://github.com/ggml-org/llama.cpp/issues/19894 (fetched 2026-07-17 — open, bug-unconfirmed)
[^qwen3nextslow]: https://github.com/ggml-org/llama.cpp/issues/17822 (fetched 2026-07-17 — open, no root cause)
[^kvquant]: https://github.com/ggml-org/llama.cpp/issues/21385 (fetched 2026-07-17 — closed as not-planned/stale)
[^specfarm]: https://vucense.com/dev-corner/speculative-decoding-explained-2x-faster-local-llms-ollama-llama-cpp-2026/ (accessed 2026-07-17) — **T4, contradicted by T1 evidence, see Contradictions**
[^xgrammarclaim]: WebSearch AI-summary attribution to https://deepwiki.com/ggml-org/llama.cpp/8.1-grammar-and-structured-output — **claim not present in the page itself when directly fetched**, see Contradictions
[^jsonschemabench]: https://arxiv.org/abs/2501.10868 (fetched 2026-07-17, abstract)
[^ollamagbnf]: https://ollama.com/blog/structured-outputs (fetched 2026-07-17, official, dated 2024-12-06) ; https://github.com/ollama/ollama/blob/main/docs/api.md (fetched 2026-07-17)
