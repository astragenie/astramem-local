# Effective run-constants baseline — 2026-07-19 (codex-only prod tuning)

Reference point for every future benchmark comparison. Machine-readable
snapshot: [`baseline-constants-20260719.json`](baseline-constants-20260719.json)
(produced by `collectRunConstants()`, `scripts/eval/shared/run-constants.ts` —
the same block every LoCoMo `run-manifest.json` and extraction-bench
`run-metadata.json` now embeds). Compare any future run's `runConstants` block
against this file to see exactly which knobs moved.

## Baseline values (as shipped at this commit)

| knob | value | notes |
|---|---|---|
| chunk `maxChunkChars` | **3200 chars (~800 tok)** | Ceiling raised to 16000 (03-chunk.ts) so codex configs MAY ask for 12800; default flip pending the chunk-size A/B (recency-bias hazard is model-independent) |
| extraction temperature | 0.1 (`ASTRA_EXTRACT_TEMP`) | **DEAD on codex** — provider drops it (endpoint 400s) |
| pass-A maxTokens | 6000 (`PASS_A_MAX_TOKENS`) | **DEAD on codex** — not forwarded; live for ollama/azure legs |
| pass-B tuning | gate 8 / cap 1500 / numCtx 8192 | KEPT (proof chain 2026-07-18: costs ~0). On codex only the skip-gate is live; cap+numCtx are ollama-only |
| num_ctx formula | clamp(chars/4 + maxTokens + 512, 4096, 16384) | ollama-only; irrelevant to codex stages |
| compaction | **`never` for codex configs** (provider-aware default, this commit) | was `auto`; codex compaction = wasted metered call + measured typeAcc harm (−23..−29). Ollama configs keep `auto` |
| chunkConcurrency | **3 for codex configs** (this commit) | was 2; ~15-18 calls/min at 10-12 s latency, under the 20/min client limit. Ollama configs keep 2 |
| embed | onnx / mxbai-embed-large / 1024-dim | local CPU worker, provider-independent |
| default LLM | codex-subscription / gpt-5.4-mini (both stages) | since v0.18.0 |
| atomTriage | `off` (repair-only enable pending ship — measured: recall 80.1 no-cost, typeAcc +9) | clerk = ollama/ministral-3:8b when enabled |
| gatekeeper | `off` | |
| OLLAMA_* env | flash-attn 1, kv q8_0, parallel 2, max-loaded 2, keep-alive −1 | only affects local clerk + local eval legs |

## Quality reference points frozen at this baseline

- 55fx extraction bench (qwen2.5:7b, no-triage, post-552A): **recall 78±1 / ~225-230 atoms / typeAcc 44** (3-control proof chain, artifact 20260718T2100Z).
- 55fx repair-only (qwen extract + ministral clerk): **recall 80.1 / typeAcc 53.4 / junk 17.7**.
- LoCoMo conv-1 k15 codex dual-pass same-day board: 0.5346-0.5502; champion 0.6002 = frozen high-water mark (codex day-variance proven; per-call yield 13 → ~10).

## Rules this baseline encodes

1. Same-day controls mandatory — codex service quality moves ±6 pts between days.
2. Never A/B `temperature`/`maxTokens` on codex — dead knobs (recorded per-run as `codexDeadKnobs`).
3. Any `maxChunkChars` > 8000 requires a same-day A/B on the target extractor first.
4. Provider-aware defaults live in `applyProviderAwareDistillDefaults` (config.ts); explicit config.yaml keys always win.
