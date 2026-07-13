---
type: run-report
created: 2026-07-13T02:05:00Z
objective: First scored LoCoMo run (FEAT-457) — full 10-conversation dataset
run_dir: C:\work\mega\astramemory-local-wt-locomo\.eval-data\locomo\runs\2026-07-12T23-58-21-695Z
status: completed — number obtained, NOT publishable as retrieval quality (see finding)
---

# LoCoMo first scored run — 2026-07-12/13

## Headline numbers (token-F1, upstream-matching scoring)

| Category | F1 | n |
|---|---|---|
| 1 multi-hop | 0.0348 | 282 |
| 2 temporal | 0.0043 | 321 |
| 3 open-domain | 0.0527 | 96 |
| 4 single-hop | 0.0200 | 841 |
| 5 adversarial (binary) | **0.9776** | 446 |
| **Category-averaged** | **0.2179** | |
| **Overall** | **0.2362** | n=1986 |

Metrics file: `<run_dir>/hypotheses.jsonl.metrics.json`.

## THE finding — this measures extraction, not retrieval

1,857 of 1,986 answers were the abstention "no information available" (which is
why adversarial scores 0.98 — abstain is correct there — and everything else
near-zero). Root cause verified in the eval datadir sqlite: **272 sessions
ingested, all transcripts present, distill completed 10/10 — but only 136
memories were extracted** (~0.5 atoms/session), typed as command:7 decision:21
event:28 fact:23 lesson:25 note:20 todo:12.

The distill pipeline's extraction prompt + durability/relevance gates are
tuned for CODING-AGENT sessions. Applied to dense personal conversations
(hobbies, relationships, life events — exactly what LoCoMo asks about), they
drop nearly everything. Retrieval then correctly finds nothing and the
answerer correctly abstains. When extraction DID store a fact, answers were
short and often right ("road trip to Jasper", "classic rock", "LGBTQ+ folks").

So 0.2362 is an honest floor for "astramem-local as-is on conversational
memory", not a measure of the retrieval stack (recall@10 ≥ 0.9 holds on the
ADR-005 harness). Zep's cited 63.8% (LongMemEval) ingests with generic
conversational extraction — apples-to-oranges against a coding-tuned gate.

## Deviations / caveats that must travel with the number

- Extraction model was `qwen2.5:7b` (daemon default), NOT the
  `qwen2.5-coder:7b` the methodology doc assumed resident. Unlikely to close
  the gap alone, but it is a protocol deviation — rerun should pin it.
- Answerer emits sentences vs reference short-spans → token-F1 harsh (known,
  documented in methodology). The optional LLM-judge pass exists for this;
  moot until extraction is fixed.
- Run died once at ~61min (external process kill, cause unproven, stderr
  empty, no error) and was resumed cleanly with `--resume` (ledger). 272/272
  sessions, 0 ingest failures, exit 0.

## Options (operator decision needed)

1. **Conversational extraction profile** — eval-scoped distill prompt +
   relaxed durability gate for non-coding transcripts. Makes LoCoMo measure
   retrieval. Real work (prompt + config surface + rerun ≈ days).
2. **Reposition**: publish the number as-is with the analysis above; lean on
   ADR-005 retrieval floors + coding-session strengths for the stable story.
   LoCoMo simply isn't the product's use-case.
3. Both: 2 now for honesty, 1 later if conversational memory becomes a goal.

## Ops notes

- Total wall: ~54 min post-resume (distill much faster than the 3.8h estimate
  — because extraction produced almost nothing; a real conversational profile
  will be slower).
- Cost: ~$1.50–3 Azure (gpt-5-mini answerer, 1,986 calls). Judge was local F1, $0.
- Eval worktree `C:\work\mega\astramemory-local-wt-locomo` (branch
  eval/locomo-20260712) kept for reruns; main checkout was never frozen after
  the worktree move.
