# LoCoMo score-improvement plan (2026-07-13)

Status: **DRAFT — under architect review**. Five candidate workstreams, ranked by
measured headroom. Nothing here is approved for build yet.

## Baseline

10% sample (1 conversation), n=199, `distill.extractProfile: conversational`,
**Ollama `qwen3:8b` extraction + compaction** (local, zero-account), embeddings
mxbai-embed-large. Overall token-F1 **0.4540**.

> **LABEL THE CONFIG — and note the direction, because it is the opposite of what
> an earlier revision of this block claimed.**
>
> An earlier edit asserted that 0.4540 was the **codex-BYO (cloud)** number and that the
> qwen3:8b label "was wrong." **That is inverted.** A later edit then claimed the manifests
> below **do not exist** and must not be cited. **They do exist.** Both claims are settled by
> the artifacts themselves — **THESE ARE FULL PATHS, CHECK THEM BEFORE RE-LITIGATING:**
>
> ```
> .claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/
>   2026-07-13T14-59-21-798Z/run-manifest.json   (1018 bytes)
>     "extractionProvider": "ollama"              -> overall_F1 = 0.45401051750038257
>   2026-07-13T15-49-03-443Z/run-manifest.json   (1032 bytes)
>     "extractionProvider": "codex-subscription"  -> overall_F1 = 0.42777774404596336
> ```
>
> (F1 from each run's sibling `hypotheses.jsonl.metrics.json`.)
>
> **Why an "exhaustive search" of `C:\work\mega\**` reported them missing:** the path is nested
> under **two dot-directories** — `.claude/worktrees/.../.eval-data/` — and `find`/glob skip
> hidden directories by default. The skepticism was right; the search was wrong. **Do not skip
> dot-dirs.**
>
> **Conclusion: 0.4540 is the LOCAL, zero-account Ollama (qwen3:8b) number.** The codex-subscription
> run scored 0.4278. Both used `extractProfile: conversational` + `compactionProvider: ollama`;
> the only variable was the extractor.
>
> **Do NOT read that as "local beats cloud."** At n=199 / one conversation, a 0.026 gap is
> **within noise**. The only defensible claim is **"local is not worse"** — which is already a
> strong result for the zero-account story, and is the claim to make publicly.
>
> The labeling discipline both earlier edits demanded is **correct and retained**: every published
> figure must state its extraction config inline. The full-sample rerun should report **both**
> configs, each cited from its own manifest.
>
> **Durable fix (this part of the earlier edit stands):** a hand-maintained config line in a
> spec is exactly how this error propagated. **The rerun must emit its config from the run
> manifest itself, not from prose.**

Decomposed by abstain (scores 0) vs answered (F1 on attempted questions):

| Category | n | % of Qs | abstain% | **F1 when answered** | Current F1 |
|---|---|---|---|---|---|
| temporal | 37 | 18.6% | 30% | **0.18** | 12.4 |
| single-hop | 70 | 35.2% | 21% | 0.57 | 44.4 |
| multi-hop | 32 | 16.1% | 19% | 0.44 | 35.4 |
| open-domain | 13 | 6.5% | **54%** | **0.73** | 33.7 |
| adversarial | 47 | 23.6% | 83% | (abstain is correct) | 83.0 |

Two facts drive the whole plan:

- **Temporal is not a retrieval problem.** We answer 70% of temporal questions
  and score 0.18 on the ones we attempt. We retrieve, then get it wrong.
- **Open-domain is purely a retrieval problem.** Best answered-F1 of any
  category (0.73) but we abstain on 54%.

## Benchmark integrity constraint — READ FIRST

`scripts/eval/locomo/answer.mts` is a **deliberately fixed, cheap answerer**
(Azure gpt-5-mini, `reasoning_effort=minimal`, 150 max tokens, k=10). Its
docstring states the rationale: *"this measures the MEMORY system, not the LLM's
world knowledge."*

**Improving the answerer prompt is out of scope for every item below.** Tuning
the answerer to score better would be gaming the benchmark and would invalidate
the measurement. All fixes must land in what we **store** and what we
**retrieve**.

Corollary that constrains the design: `buildAnswerPrompt` passes **only
`h.text`** to the answerer (`answer.mts:40`). No metadata, no `valid_from`, no
timestamps. **If a fact is not in the memory's text, it cannot reach the
answerer.** A bitemporal column the answerer never sees is worth zero LoCoMo
points.

## 1. Temporal — resolve time deixis at extraction (est +7 pts)

**Root cause (measured, not hypothesised).** Sampled 191 memories from the eval
run's datadir:

- Only **19.9%** contain any date/time expression at all.
- Those that do carry **unresolved relative dates**:
  - `"Caroline attended an LGBTQ support group yesterday..."`
  - `"Melanie shared a painting of a sunset over a lake, which she painted last year..."`

"Yesterday" relative to **what**? The session date is never anchored into the
atom text, and per the constraint above, the answerer sees nothing but that text.
LoCoMo temporal questions ask "how long ago / when did X happen" — unanswerable
from a floating "yesterday".

The conversational extraction prompt already performs **pronoun** resolution
("Caroline", not "she"). It does **not** perform **time-deixis** resolution.
That is the entire gap, and the symmetry is the fix.

**Direction.** Anchor relative time expressions to absolute dates at extraction
time, using the session timestamp. `"...support group yesterday"` →
`"...support group on 2023-05-14"`. This is the temporal-grounding step
mem0/Graphiti both do.

**Open questions for architect:**
- Does the ingest envelope actually carry a per-session date through to distill?
  If not, that plumbing is a prerequisite and may dominate the cost.
- Prompt-level resolution (cheap, stochastic) vs. deterministic post-pass over
  extracted atoms (auditable, but needs a date parser)?
- Do we ALSO populate `valid_from`? It earns no LoCoMo points (answerer never
  sees it) but is the honest bitemporal fix. Sequence it, don't conflate it.

**Trap:** FEAT-486 as filed assumes a *retrieval* fix (invoke the `as_of`
machinery). The data says that is the wrong diagnosis. Re-scope before building.

## 2. Single-hop precision (est +5 pts)

Largest mass — 35.2% of all questions — at answered-F1 0.57. No root cause
established yet. Ranking/fusion quality in `src/search/fuse.ts`,
`rerank.ts`, `presets.ts`.

**Architect owes:** a diagnosis before a fix. Is the right memory retrieved but
ranked below k=10? Or not retrieved at all? These need opposite remedies
(rerank tuning vs. recall/embedding). Instrument first.

## 3. Multi-hop — 1-hop graph expansion (est +2 pts)

`entity_relations` (FEAT-481, migration 027) shipped and is populated. **Recall
does no graph expansion over it.** Built, wired, never invoked — the same
pattern this repo keeps hitting.

**Direction.** Optional 1-hop expansion on recall: seed hits → neighbours via
`entity_relations` → merge into candidate set. This was explicitly named as the
v1 retrieval surface in FEAT-481's own intake and never built.

**Risk:** expansion adds candidates, which can *dilute* precision and hurt
single-hop (#2). Must be evaluated jointly, not in isolation.

## 4. Open-domain recall miss (est +1.8 pts)

Abstains on 54% but scores **0.73** when it answers — the best answered-F1 of any
category. Pure retrieval miss: when we find it, we nail it.

**Caveat that must not be skipped:** n=13, of which only **6 were answered**. The
0.73 rests on six questions. Confirm on a full sample before spending real effort.

## 5. Abstention calibration (cross-cutting)

39 of 152 non-adversarial questions are abstained — 26% of what we should be
answering.

**The trap.** Adversarial (23.6% of all questions) scores **83.0 by abstaining**.
A global "abstain less" knob trades those points straight back and is plausibly
net-negative. Any fix must discriminate "no memory retrieved" (correct abstain)
from "memory retrieved but answerer wasn't convinced" (wrong abstain) — and per
the integrity constraint, it cannot be fixed by softening the answerer prompt.

Likely this is a *consequence* of 1–4, not an independent workstream. Measure
after those land before funding it separately.

## Explicitly NOT score levers

- **FEAT-485 (evidence extraction).** Token-F1 scores answer-text overlap;
  provenance fields are not in the answer. Real feature (trust, auditability,
  doctor canary) — **zero LoCoMo impact**. Do not fund it expecting score.
- **The 15 Zod poison jobs.** Production memory-quality damage. The eval runs
  clean at 10.05 atoms/session. Fix it for prod, not for score.

## Global caveats

- n=199, **one conversation**, 10% sample. Per-category n is 13–70.
- Open-domain's headline rests on 6 answered questions.
- All point estimates are arithmetic headroom, not predictions.
- **Full-sample rerun required** before trusting #3 and #4 sizing.
