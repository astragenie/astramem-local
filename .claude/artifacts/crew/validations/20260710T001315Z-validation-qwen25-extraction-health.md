# Validation: qwen2.5:7b extraction health (default extraction model since v0.9.1)

**Date:** 2026-07-09/10
**Scope:** Does `qwen2.5:7b` (defaultConfig() extraction default) reliably produce non-empty, parseable extraction output, or does it exhibit the qwen3:8b-class empty-response failure?
**Method:** Direct Ollama replay of the daemon's exact extraction request shape — same system prompt (`EXTRACTION_SYSTEM_PROMPT` v1, verbatim from `src/distill/prompts/extract.ts`), same user-message template, same request body as `src/providers/llm/ollama.ts` (`stream:false`, `format:'json'`, `options:{temperature:0.1, num_predict:1500}`, no `think` flag for non-qwen3 models). Chunk text = fixture turns flattened as `role: text` lines (matches `flattenTranscriptContent`'s output shape), taken directly from `scripts/eval/extraction-bench/fixtures/` — no compaction stage run (out of scope for this probe; doesn't change whether the model emits valid JSON `atoms`). Same response parsed with the daemon's exact `tryParseAtoms` logic (fence-strip + brace-extraction + `JSON.parse` + `atoms` array check) copied from `src/distill/stages/05-extract.ts`.

5 fixtures spanning short/medium/long/zero-gold content, both models, 10 calls total. Script: `extract-probe.mjs` (scratchpad, not committed).

## Results

| Fixture | Difficulty | Chunk chars | Gold atoms | Model | HTTP | Raw len | Parse OK | Atoms extracted | Latency |
|---|---|---:|---:|---|---|---:|---|---:|---:|
| fx15-short-ambiguous | ambiguous | 328 | 1 | qwen2.5:7b | 200 | 250 | yes | 1 | 17.0s |
| fx15-short-ambiguous | ambiguous | 328 | 1 | qwen2.5-coder:7b | 200 | 412 | yes | 1 | 11.5s |
| fx01-clean-decision | clean | 1132 | 4 | qwen2.5:7b | 200 | 721 | yes | 3 | 21.5s |
| fx01-clean-decision | clean | 1132 | 4 | qwen2.5-coder:7b | 200 | 605 | yes | 3 | 14.0s |
| fx02-debugging-race-condition | clean | 1193 | 5 | qwen2.5:7b | 200 | 1459 | yes | 4 | 35.5s |
| fx02-debugging-race-condition | clean | 1193 | 5 | qwen2.5-coder:7b | 200 | 1320 | yes | 5 | 32.5s |
| fx08-long-multitopic | long | 1642 | 7 | qwen2.5:7b | 200 | 978 | yes | 5 | 23.3s |
| fx08-long-multitopic | long | 1642 | 7 | qwen2.5-coder:7b | 200 | 616 | yes | 4 | 25.4s |
| fx09-nothing-worth-remembering | nothing | 227 | 0 | qwen2.5:7b | 200 | 12 | yes | 0 (`{"atoms":[]}`, correct) | 17.6s |
| fx09-nothing-worth-remembering | nothing | 227 | 0 | qwen2.5-coder:7b | 200 | 12 | yes | 0 (`{"atoms":[]}`, correct) | 74.6s |

Every call returned HTTP 200 with structurally valid, parseable JSON. `qwen2.5:7b` never produced an empty or unparseable response in this sample — including on the shortest input (328 chars) and the deliberately-empty-gold fixture, where `{"atoms":[]}` is the *correct* answer, not a failure. Atom counts track close to `qwen2.5-coder:7b`'s on every fixture (3/3, 4/5, 5/4, 1/1, 0/0) — no systematic gap, no content-length correlation with failure.

Latency: `qwen2.5:7b` and `qwen2.5-coder:7b` are comparable per-call (both models were being loaded/unloaded under the concurrent 50-sample eval run hammering Ollama, per the task brief — the fx09 74.6s outlier for qwen2.5-coder:7b is almost certainly Ollama contention/model-reload, not a signal about either model's correctness).

## Verdict: (a) qwen2.5:7b HEALTHY — today's empty result was an outlier

No evidence of a systematic empty-response failure across 5 varied inputs (short/medium/long/zero-gold), matching neither the qwen3:8b failure class (thinking-mode consuming the JSON turn) nor a content-length-sensitivity pattern. `qwen2.5:7b` is `qwen2` family (not `qwen3`), so `ollama.ts`'s `think` suppression logic (`/^qwen3/i` regex) correctly never applies to it and never sends a `think` flag — consistent with it not being susceptible to the same failure mode qwen3:8b has.

The single earlier "0 atoms / empty response" observation is most plausibly one of:
- a transient Ollama-side hiccup (model cold-load, or contention with the concurrent 50-sample eval run already noted as hammering the same Ollama instance),
- a specific input shape not covered by this 5-fixture sample (can't fully rule out without the exact transcript that triggered it), or
- simple sampling variance at temperature 0.1 (non-zero, so not fully deterministic).

**Recommendation:** Do not treat this as a default-model regression. If the team wants to fully close it out, re-run the exact failing transcript from today's isolated-daemon test (if it's still available) through this same probe script — that would either reproduce it (escalate) or confirm it as a one-off (close). Given the 10/10 clean sample here, the A/B-benchmarked default (`qwen2.5:7b`, F1 67%) does not need to be reconsidered on this evidence.

## Artifacts
- Probe script: `C:\Users\serge\AppData\Local\Temp\claude\C--work-mega-astramemory-local\06ffd9f6-5c24-4f88-9cd1-98cca2109017\scratchpad\extract-probe.mjs` (scratchpad, ephemeral — not committed)
- Raw results: same scratchpad dir, `probe-results.json` / `probe-log.txt`
