# Evaluation methodology

astramemory-local's retrieval and extraction quality is measured by three harnesses at
different maturity levels: one is a CI-gated regression floor, one is a manual benchmark with
published numbers, and one is a built-but-not-yet-scored adapter for an external benchmark. This
doc says honestly which is which — see each section's "Status" line.

## 1. ADR-005 retrieval eval gate — CI-gated, every push

**Status: live, enforced on every push/PR to `main`.**

[ADR-005](../adr/ADR-005-retrieval-contract.md) defines a shared eval-harness contract: a fixture
corpus of `(query → graded-relevant atoms)` covering every memory type, temporal cases
(superseded vs. current), entity queries, and cross-session recall. `tests/eval/retrieval-eval.test.ts`
runs that corpus through the real hybrid search path (BM25 + vector + importance + freshness
fusion, `src/search/`) with a **deterministic fake embedder** (`makeFakeVec`, `src/search/search.ts`)
so scores are stable across machines and OSes — the semantic leg carries no real embedding
signal, so these are a regression floor for the FTS+fusion pipeline, not an absolute retrieval-
quality claim.

Gated thresholds (see `tests/eval/retrieval-eval.test.ts`):

- **recall@10 ≥ 0.9**
- **NDCG@10 ≥ 0.7**

The suite currently measures mean recall@10 ≈ 0.929 and mean NDCG@10 ≈ 0.748 — the floors sit
just below with a small margin. A regression here fails `bun run test` the same as any other
test; there is no separate opt-in step.

**Reproduce it:**

```bash
bun install
bun run build
bun run test                      # full vitest suite, includes the ADR-005 gate
bun run test -- tests/eval        # just the eval-harness tests
```

Fixtures live at `contracts/fixtures/eval/corpus.json` and `queries.json`. Re-baseline the
floors deliberately (with a commit explaining why) whenever ranking behavior changes on purpose
— see the ADR-005 addendum on the cross-encoder rerank seam for an example of a change that was
deliberately shipped without moving the default floors.

## 2. Extraction bench — manual benchmark, numbers published

**Status: implemented and run; results committed under `scripts/eval/extraction-bench/results/`.**

[`scripts/eval/extraction-bench/`](../../scripts/eval/extraction-bench/README.md) measures which
LLM produces the best typed-atom extraction for the distill pipeline's extract stage
(`src/distill/stages/05-extract.ts`), given the current production default is
`qwen2.5-coder:7b`. It is a manual benchmark you run on demand — not part of CI — because it
calls a real Ollama model (or Azure) per fixture and takes real wall-clock time and (for the
Azure judge) real spend.

**What it measures:** 15 hand-authored gold transcript fixtures
(`scripts/eval/extraction-bench/fixtures/`) spanning clean decisions, noisy tool spam, long
multi-topic sessions, contradictions/corrections, secrets-present sessions, and a "nothing worth
remembering" negative case. Each fixture is run through the real extraction stage, and the
resulting atoms are judged against the gold answer key by Azure `gpt-5-mini`
(`reasoning_effort: minimal`) for recall, precision, type accuracy, and (for the empty-fixture
case) over-extraction count. `llm.compaction` is held constant so only the extraction model
varies.

Most recent published run (`scripts/eval/extraction-bench/results/real-run-2026-07-08/report.md`):

| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract | Avg s/session |
|---|---|---|---|---|---|---|---|
| qwen2.5-coder:7b (current default) | 43% | 87% | 57% | 12% | 31% | 0 | 9.9s |
| llama3.1:8b | 53% | 87% | 66% | 10% | 37% | 2 | 29.8s |
| qwen2.5-coder:14b | 41% | 95% | 57% | 3% | 42% | 0 | 72.7s |
| azure:gpt-5-mini (reference) | 55% | 86% | 67% | 13% | 57% | 1 | 8.7s |

**Reproduce it:**

```bash
bun scripts/eval/extraction-bench/run-bench.mts --models qwen2.5-coder:7b,llama3.1:8b
# or via the package.json script (args after -- are passed through):
bun run eval:extraction-bench -- --models qwen2.5-coder:7b,llama3.1:8b,azure:gpt-5-mini

# quick plumbing check, zero Azure spend (skips the judge call):
bun scripts/eval/extraction-bench/run-bench.mts --models qwen2.5-coder:7b --skip-judge --fixtures-dir scripts/eval/extraction-bench/fixtures
```

Ollama candidates run the daemon HTTP path (a fully isolated daemon spawned per run); Azure
deployments run an in-process pipeline path (see the bench's own README for why `gpt-5-mini`
needs that — it's a reasoning model and the daemon's own Azure provider doesn't yet support
`max_completion_tokens`/no-temperature calls). Each run writes a new timestamped directory under
`scripts/eval/extraction-bench/results/` with the full per-atom judge verdicts (`results.json`)
and the summary table (`report.md`).

## 3. LongMemEval adapter — built, methodology public, scored numbers not yet published

**Status: adapter code complete and throughput-measured; no full scored run has been completed
on this codebase yet. Do not cite a LongMemEval accuracy number for astramemory-local — none
exists.**

[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025) is a third-party long-term-
memory benchmark: 500 questions, each requiring recall from a synthetic haystack of ~40-50 prior
chat sessions. [`docs/eval/longmemeval-plan.md`](longmemeval-plan.md) is the design doc;
[`scripts/eval/longmemeval/README.md`](../../scripts/eval/longmemeval/README.md) is the
as-built adapter documentation, including two real daemon-side gaps discovered while building it
(bitemporal `as_of` currently keys off ingest wall-clock time rather than `captured_at`, and
poison distill jobs can report `ready` via the digest endpoint) that would need to be resolved
before temporal-reasoning/knowledge-update questions can be scored meaningfully.

What's done: the full ingest → distill-wait → recall → answer → judge pipeline
(`scripts/eval/longmemeval/*.mts`), a stratified 50-question sampler, sharding across isolated
daemon instances, and a vendored Azure-compatible fork of the official judge script
(`judge/evaluate_qa_azure.py`) that keeps scoring logic byte-identical to upstream. What's not
done: a completed judged run. Measured throughput (real, not estimated) is roughly 45-60 seconds
per session for the local `qwen2.5-coder:7b` extraction step on the hardware this was profiled
on, which puts a full 500-question run (~24,500 sessions) at the better part of two days
single-threaded — parallelism (sharding) is a prerequisite, not an optimization, before a full
run is practical.

**Reproduce the smoke pipeline (does not require a full run):**

```bash
bun install
bun run build
bun run eval:longmemeval:sample     # draw the stratified sample only
bun run eval:longmemeval:smoke      # full phase-1 pipeline: sample -> ingest -> distill-wait -> answer
bun run eval:longmemeval:judge -- --hyp <path-to-hypotheses.jsonl> --ref .eval-data/longmemeval/longmemeval_s_cleaned.json
```

Run real (multi-minute-plus) smoke or full runs from a plain terminal you control, not from
inside a coding-agent's sandboxed shell tool — see the adapter README's "Run real smoke/full
runs" section for why (a sandboxed session on this project's dev machine was observed silently
reaping a live daemon process mid-run). When a full scored run does complete, its numbers and
run manifest will be published here and in the adapter README, not asserted in advance.
