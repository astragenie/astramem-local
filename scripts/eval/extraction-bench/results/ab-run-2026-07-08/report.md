# Extraction-bench results

> **⚠ ANNOTATED 2026-07-13 — the `qwen3:8b` row below is INVALID. Do not cite it.**
>
> This run was built from commit `8738876` (2026-07-08 09:00:01 -0500), on the
> original 15-fixture set. **`src/providers/llm/ollama.ts` did not set Ollama's
> `think` parameter for any model at that commit** — every call ran at Ollama's
> per-model default, which is thinking-ON for qwen3. The fix that disables
> thinking for qwen3* by default (`this.think = config.think ?? (/^qwen3/i.test(this.model)
> ? false : undefined)`) landed **28+ hours later**, in commit `1915521`
> (2026-07-09 13:31:10 -0500, "Extraction: codex/qwen3 fixes + eval infra
> (prompt/temp a/b, cloud bench specs)", #150). That commit's own message states
> the mechanism: "qwen3 defaults to thinking-on, which returns an empty body
> under format:json and poisons distill; disabling it makes qwen3 emit JSON."
>
> Effect on the `qwen3:8b` row below: the **52.3s avg s/session** (2.4× the
> `qwen2.5:7b` row's 21.6s) is reasoning-token overhead burned on every fixture,
> not a property of the model. The **31% type accuracy** (worst of all 6 models
> in this run, below even `qwen2.5:7b`'s 51%) and the **1 failed fixture** are
> both consequences of the same defect: thinking-on + `format:json` returning an
> empty `message.content` on some calls, which the judge/harness sees as a
> degraded or poisoned parse, not a genuine quality signal. None of the other
> rows in this table use a qwen3* model, so they are unaffected.
>
> This report also predates two other fixes relevant to interpreting it:
> `ecd8c5f` (2026-07-13, JSON was being forced onto the prose **compaction**
> stage for every candidate, corrupting compaction output before extraction ever
> ran) and `dc54ef5` (2026-07-13, `num_ctx` was never set and ran at Ollama's
> ~4096 default, silently truncating longer prompts). Every row in this table,
> not just qwen3:8b, was measured on code with these two bugs still present.
>
> Root cause of why this went unnoticed for 5 days: **this file records no code
> version, no Ollama env, and no fixture-set identity** — `results.json` for
> this run has only `model / daemonBootMs / fixtures / aggregate` keys. An
> unpinned, uninterpretable run is a defect in the same class as the LoCoMo run
> that never recorded it had silently run the wrong model. The current bench
> script now writes this metadata into a sibling `run-metadata.json` for every
> future run (`results.json` itself keeps its documented plain-array shape —
> see `run-bench.mts:316-319`'s AC-5 comment — so this doesn't touch a
> contract other code depends on).
>
> **Superseding measurement:** `../ab-run-model-ab-2026-07-13/report.md` —
> `qwen2.5:7b` vs `qwen3:8b`, same column shape, `--runs 3` (mean±stdev, not a
> single sample), on top-of-tree code with all three fixes above, on the current
> 43-fixture set, with `runMetadata` recorded. Use that report for the
> local-default decision, not this one.
>
> The numbers below are left unmodified as the historical record of what that
> run actually produced — they are annotated, not corrected.

| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ |
|---|---|---|---|---|---|---|---|---|---|
| qwen2.5-coder:7b | 44% | 90% | 59% | 8% | 40% | 0 | 8.7s | 0 | $0.0000 |
| qwen2.5:7b | 51% | 99% | 67% | 1% | 51% | 0 | 21.6s | 1 | $0.0000 |
| qwen3:8b | 48% | 98% | 65% | 1% | 31% | 0 | 52.3s | 1 | $0.0000 |
| phi4-mini | 37% | 100% | 54% | 0% | 56% | 0 | 28.8s | 0 | $0.0000 |
| nuextract:adapted | 0% | — | — | 0% | — | 0 | 17.9s | 0 | $0.0000 |
| azure:gpt-5-mini | 68% | 100% | 81% | 0% | 55% | 0 | 8.5s | 0 | $0.0146 |

_Judge: Azure gpt-5-mini (reasoning_effort=minimal). Estimated judge spend this run: ~$0.084._