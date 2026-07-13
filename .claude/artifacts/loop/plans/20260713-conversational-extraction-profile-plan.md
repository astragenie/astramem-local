---
type: plan
created: 2026-07-13T08:15:00Z
author: lead (session e08b8f83, Fable)
objective: Human-readable / conversational extraction profile — close the LoCoMo extraction gap, lean the product toward normal human memories
status: proposed — awaiting operator approval
inputs:
  - .claude/artifacts/crew/runs/20260713T020500Z-locomo-first-scored-run.md
  - competitor code research 2026-07-13 (mem0, Graphiti, Letta, LangMem, supermemory)
---

# Plan: conversational ("human-readable") extraction profile

## 0. What the research established

### Why we scored 23.62 F1 with 136 atoms

NOT the durability gate (it ships **off**). The extraction **prompt is the
filter**: taxonomy definitions and all few-shot examples are engineering-shaped
("command = shell incantation worth reusing"; v2's bar is literally "would
retrieving this six months from now help another engineer?"). A conversation
about a road trip has nowhere to land except `note`. The pipeline did exactly
what its prompt says.

### The honest scoreboard (metric-matched)

| System | LoCoMo score | Metric |
|---|---|---|
| Mistral-7B (orig. paper) | 13.9 | token-F1 |
| GPT-3.5-turbo (orig. paper) | 22.4 | token-F1 |
| **astramem-local today** | **23.6** | **token-F1** |
| GPT-4-turbo (orig. paper) | 32.1 | token-F1 |
| Best RAG config (orig. paper) | 41.4 | token-F1 |
| Human ceiling | 87.9 | token-F1 |
| mem0 / Zep / Letta / Memobase | 66.9 / 75.1 / 74.0 / 75.8 | LLM-judge (lenient; NOT comparable) |

We match GPT-3.5-class baselines **while storing 0.5 atoms/session**. The
retrieval stack never got to play. **Rerun target: > 41.4 token-F1** (beat the
original paper's best RAG) — that's the defensible public claim; an optional
LLM-judge pass gives a vendor-comparable number with loud caveats.

### What competitors do differently (patterns worth stealing)

1. **mem0 (liberal extraction)**: "When in doubt, extract… pets, hobbies,
   childhood memories, funny anecdotes… are often the MOST valuable." 15–80
   word self-contained sentences; resolve pronouns; never genericize proper
   nouns ("Ferrari 488 GTB" not "sports car"); ground relative dates against
   an explicit Observation Date; dedup downstream (hash), not gate upstream.
   Stored memories are plain human-readable sentences.
2. **Graphiti (precision rules)**: possessor-qualification ("Nisha's dad",
   never bare "dad"); hard negative-example lists (ban abstract concepts:
   joy, growth, resilience); dedicated never-hallucinate-dates pass. Only
   system besides us doing temporal validity (valid_at/invalid_at — parity).
3. **Letta + LangMem (duality)**: every serious system runs BOTH an atom
   collection AND a profile surface. We already have this shape
   (memories + user_profile rollups) — we don't need new architecture,
   only content flowing into it.
4. **mem0's LoCoMo answerer**: 7-step chain-of-thought that FORBIDS
   "not specified" hedging — hill-climbed against the benchmark. Our
   answerer abstains freely (correct behavior, brutal on F1 cat 1–4).

## 1. Design decisions (proposed)

- **D1 — No new memory types.** Existing 7 types map onto human life cleanly
  once redefined (fact=personal fact, note=preference/opinion, event=life
  event/milestone, lesson=personal realization, decision=life choice,
  todo=plan/intention, command→unused). Zero schema/wire/SaaS migration;
  profile rollups (fact/note/lesson/decision) light up automatically.
- **D2 — Profile is a config/per-request switch, not a fork.**
  `distill.extractProfile: 'engineering' | 'conversational'` in config.yaml
  (default `engineering` — current behavior byte-identical), plus optional
  `extract_profile` field on the canonical ingest envelope so one daemon can
  serve coding hooks AND conversational sources (proxy capture, imports).
  Replaces the module-load `ASTRA_EXTRACT_PROMPT` env resolution with
  per-pipeline-run resolution (env var kept as override for compat).
- **D3 — Prompt borrows the proven patterns**: mem0's liberal posture +
  self-contained 15–80-word sentences + pronoun resolution + proper-noun
  preservation + observation-date grounding; Graphiti's possessor
  qualification + banned-abstractions negative list. Keep our typed output
  contract and entity extraction (kinds already include actor/event/concept;
  no enum change needed — D1 logic).
- **D4 — Answerer changes are eval-scoped and principled**: adopt structured
  answer steps + prefer-specific-answer, but keep abstention when retrieval
  is genuinely empty (that's product-correct; mem0's forbid-hedging is
  benchmark overfitting we don't copy blindly). Category 5 keeps rewarding
  abstention either way.
- **D5 — Extraction model stays qwen2.5:7b** (it beat coder-7b on the
  extraction bench). Methodology doc gets corrected (it wrongly assumes
  coder). Rerun pins it explicitly.

## 2. Slices

| Slice | What | Est |
|---|---|---|
| S1 | Config surface: `distill.extractProfile` (config.yaml + writer + init round-trip), optional `extract_profile` on canonical envelope (zod, additive/optional → no wire break), thread through pipeline ctx to 05-extract prompt selection. Tests: config round-trip, envelope validation, prompt-selection unit. | ~1d |
| S2 | `EXTRACTION_SYSTEM_PROMPT_CONVERSATIONAL` in src/distill/prompts/extract.ts per D3, with worked examples from casual dialog (trip, pet, health, relationship, milestone). Small conversational fixture set + judge additions to extraction-bench so the prompt has a measured baseline (target: atoms/session and precision on 3–5 hand-labeled LoCoMo sessions). | 1–2d |
| S3 | Eval answerer improvements per D4 (scripts/eval/locomo/answer.mts) + methodology doc corrections (model pin, metric-comparison table from §0). | ~0.5d |
| S4 | LoCoMo rerun in the kept worktree (`astramemory-local-wt-locomo`), conversational profile ON, model pinned, `--distill-timeout-ms 28800000 --detach`. Expect slower distill (real extraction now — budget the full ~4h+). Score F1; optional LLM-judge pass for the comparable-with-caveats number. Publish per run-report conventions. | run + 0.5d |
| S5 (optional, later) | Profile surface polish: `events`/`milestones` section in user_profile (event type currently feeds nothing), possessor-qualified entity naming guidance. Product decision, not needed for the rerun. | ~1d |

Total: **~3–4 dev-days + one ~4h rerun**. S1+S2 are the critical path; S3
parallel-safe (different files); S4 gates on S1–S3.

## 3. Risks / honesty notes

- **qwen2.5:7b on conversational content is unmeasured** — the 67% F1 bench
  was engineering transcripts. S2's fixture bench exists precisely to catch
  this before burning a 4h run. Fallback: try qwen2.5-coder:7b / llama3.1:8b
  on the same fixtures.
- **Liberal extraction bloats coding sessions if misapplied** — that's why D2
  keys the profile per source and defaults to engineering. Auto-capture hooks
  stay engineering; only explicitly conversational ingest flips.
- **Benchmark-overfitting temptation**: mem0's answerer bans honest
  abstention; two vendors' numbers already collapsed under third-party audit
  (LoCoMo also has ~6.4% corrupted ground truth capping honest scores). We
  publish F1 vs the F1 column, judge-score only with the caveat paragraph.
- Distill wall-clock will grow ~5–10× on conversational data (real atoms per
  session instead of 0.5). Fine for eval; relevant if conversational ingest
  becomes a production path later.

## 4. Immediate next actions on approval

1. Open FEAT via `/runner:intake` (this doc as spec body), slice per §2.
2. S1+S2 dispatch to builder; S3 parallel; review gate as usual.
3. S4 rerun → new run-report artifact → update stable-promotion language with
   the metric-matched table from §0.
