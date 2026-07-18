---
kind: eval-evidence
component: atom-triage clerk seat (distill.atomTriage --triage-model)
run_at: 2026-07-18
decision: ministral-3:8b = first clerk passing all gates on 5fx screen; 55fx confirm + LoCoMo leg queued before any enable
---
# Clerk A/B sweep — phi4-mini vs ministral-3:8b vs llama3.2:3b vs qwen2.5:3b

Harness: `scripts/eval/extraction-bench/run-bench.mts --models qwen2.5:7b
--fixtures-dir scratchpad/fx5-clerk --atom-triage enabled --triage-model <clerk>`,
5 fixtures (fx01–fx05), sequential legs, clerk unloaded between legs.
Results: `scripts/eval/extraction-bench/results/clerk-ab-2026-07-18/`.

| leg | recall | prec | typeAcc | junk | wall 5fx |
|---|---|---|---|---|---|
| control (no triage) | 68 | 90 | 31 | 10% | 213s |
| phi4-mini | 49 | 90 | 43 | 10% | 246s |
| **ministral-3:8b** | **67** | **100** | **59** | **0%** | 339s |
| llama3.2:3b | 31 | 70 | 43 | 10% | 254s |
| qwen2.5:3b | 70 | 81 | 42 | 19% | 242s |

## Findings

1. **ministral-3:8b is the first clerk to pass the recall-held ≥95% gate** (67/68 =
   98.5%) while improving every other axis: typeAcc 31→59 (best clerk number measured,
   above phi's 58 seat record from the 547 wave), precision 90→100, junk 10→0.
   The FEAT-547 "keep/junk triage NO-ENABLE" verdict was clerk-specific, not
   seat-specific.
2. **llama3.2:3b rejected** — worst clerk measured (recall −37, precision −20).
3. **qwen2.5:3b rejected for triage** — permissive: holds recall but keeps junk
   (19%) and drops precision. Possible gatekeeper candidate (cheap, non-destructive
   seat), unmeasured.
4. **Wall +59% for ministral is a bench artifact**: 6.0GB-disk / 5.4GB-VRAM ministral
   cannot co-reside with the 4.8GB qwen2.5:7b extractor → per-batch model swap. Prod
   extraction is codex (cloud) + ONNX embed (in-process): ministral would be the sole
   GPU tenant. Measured sole-tenant: 5.4GB VRAM, 55 tok/s.
5. License: Apache 2.0 (Ministral 3 family, official Ollama `ministral-3:8b`).

## Caveats
5 fixtures, n=1, judge noise real (~7 F1 pts per bench README). Enable decision
requires: 55fx confirmation run (killed to free GPU for the LoCoMo leg; re-queue)
and the LoCoMo end-to-end leg (codex-A + ministral-B gated sweeper, running).
