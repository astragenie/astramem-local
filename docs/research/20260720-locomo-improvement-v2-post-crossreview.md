# LoCoMo improvement plan v2 — post cross-review (measure-first, re-scoped)

**Supersedes** `20260719-locomo-0.70-research-for-cross-review.md` (v1). v1 was fed to a
5-way adversarial cross-review (codex/gstack, two architect-reviewers, critical-thinking,
performance-engineer). **All five independently returned RE-SCOPE.** This v2 folds their
findings in. Review artifacts: `.claude/artifacts/crew/reviews/2026072{0}*` +
`.claude/artifacts/crew/handoffs/20260720*`.

## What the cross-review changed (v1 was wrong on the central bet)

- **v1's §5 bet is FALSIFIED.** v1 bet single-hop's 0.49 is an *answerer/format* problem.
  The repo's own `docs/research/20260713-single-hop-root-cause.md` (uncited in v1) already
  measured it: **36–47% of single-hop gold facts are never captured as an atom anywhere in
  the store.** It's mostly an **extraction-completeness** problem, a third cause v1's binary
  (retrieval-vs-answerer) framing omitted.
- **The multi-hop decomposer was never even ON.** `config.multiHop.enabled` defaults `false`
  and no archived baseline overrode it — so multi-hop's 0.36 was scored with the #266-fixed
  WS6 decomposer **disabled**. v1 cited that score as evidence about a feature that wasn't running.
- **A third scoring axis exists.** The scorer's `f1Score` precision term penalises verbose-but-
  correct answers; temporal/adversarial gold shapes are length-constrained, single-hop's are not.
  The methodology doc mandates an `--llm-judge` semantic score alongside F1 for exactly this
  reason — v1 never mentions it.
- **The arithmetic reaches 0.6816, not 0.70** (perf-eng recomputed it — the math is sound, but
  the last 0.018 is unsourced; on the board's category-avg convention it's 0.654).
- **It's statistically underpowered.** Minimum detectable effect at n=199 is ~14 pts > v1's own
  ~11-pt target; per-category MDEs (single-hop 23, multi-hop 34, open-domain 52) exceed their
  targets. No single-run delta is distinguishable from the codex ±6-pt/day variance.
- **conv-1 is a clustering problem, not a small-n problem** — effective sample ≈ **1 conversation**,
  not 199. v1 violated its own "n=1986, ≥3 runs" rule to build its headline.
- **The "frozen answerer" is frozen BY DESIGN** — a fixed cheap model so the eval measures the
  *memory system*, not the answering LLM. A stronger answerer reintroduces the exact confound the
  harness exists to avoid and weakens the local-first story.
- **`+7.86` retrieval ceiling is stale** (computed on the pre-fix 0.461 pipeline; descends from
  the 42%-FN diagnostic).

## Current state (accurate, two same-config runs)

| category | 07-18 | 07-19 | n | note |
|---|---|---|---|---|
| adversarial | 0.830 | 0.809 | 47 | near ceiling |
| temporal | 0.665 | 0.683 | 37 | strong (only large-effect result that survives power analysis) |
| single-hop | 0.511 | 0.492 | 70 | biggest category; **≥36–47% of gold never extracted** |
| open-domain | 0.369 | 0.368 | 13 | unusable at n=13 (±27pt half-width) |
| multi-hop | 0.376 | 0.363 | 32 | **decomposer was OFF** in these runs |
| **overall** | **0.584** | **0.573** | 199 | cat-avg 0.550 / 0.543 |

Scale: conv-1, n=199, ONE conversation. Full-suite (n=1986) best on record 0.484 (older recipe, not comparable).

## Re-scoped goal
**Stable full-suite 0.62 with no catastrophic per-conversation or per-category regression**, measured
as a ≥3-run median with reported dispersion. **0.70 is a stretch, gated** on the oracle-factorial (below)
showing a real answerer ceiling AND the change preserving local-first constraints. A lucky-day 0.70 on
one conversation is not a result.

> **UPDATE 2026-07-20 — the oracle-factorial gate has RESOLVED (Phase 1 below).** It found a real
> perfect-evidence ceiling of ~0.53 with the frozen answerer. **0.70 is effectively off the table for
> memory-pipeline work** — even perfect evidence can't reach it under the current answerer+scorer, and a
> stronger answerer is a rejected mechanism. Retarget on **stable full-suite 0.62** via the ~7-point
> single-hop-retrieval + multi-hop headroom Phase 1 identified; treat any approach to 0.70 as requiring an
> out-of-scope answerer change, not a memory fix.

## The plan — measure before building (cheap-first, ordered by cost:evidence)

### Phase 0 — free / near-free measurements (no or minimal LLM cost)
0.1 **Precision-term analysis** (ZERO LLM). Parse archived `hypotheses.jsonl`: for single-hop questions,
    split failures into precision-penalty (verbose-but-correct) vs recall-miss vs never-retrieved. Settles
    whether single-hop is the scorer-artifact (c) axis. Cheapest possible signal.
0.2 **`multiHop.enabled: true` same-day A/B** (config-only, one conv-1 pair). The decomposer has never
    been measured on real questions. Free config flip, bounded eval cost. Highest cheap upside for multi-hop.
0.3 **Answerer `reasoning_effort` minimal→low A/B** (`answer.mts`/`judge.mts`), RAISING the shared 150-token
    budget so answers don't truncate to empty. FEAT-450 measured minimal→low as a win on this model family.
    One conv-1 pair.

### Phase 1 — the oracle factorial (the honest ceiling) — ✅ DONE 2026-07-20
Answer each question from: gold-source-turns · gold-atoms · retrieved-atoms · retrieved-source-spans, crossed
with current-answerer vs canonical-renderer. Measures the true ceiling of EACH stage (extraction,
retrieval, evidence-sufficiency, answering, scoring) before any build.

**Built + run.** Harness: `scripts/eval/locomo/oracle/`. Full result + caveats:
`docs/eval-runs/20260720-oracle-factorial/README.md`. Attribution (llm-judge, conv-26, n=152 cat1-4):

```
gold-turns (PERFECT evidence)  0.526   ceiling — answerer + scorer, evidence cannot be blamed
gold-atoms                     0.468   extraction loss  −0.058
retrieved-atoms (real pipeline)0.461   retrieval  loss  −0.007   (≈ P0a rescore 0.463 → harness faithful)
Zep target                     0.947   remaining −0.42 = answerer / scorer / evidence-sufficiency ceiling
```

**Verdict: ~87% of the gap is downstream of the memory pipeline.** Handed the literal cited answer
turns, the current answerer+scorer tops out at ~0.53. `canonical ≈ current` (±1–2 pts) → the ceiling is
real, not a metric artifact. This **refutes the extraction-completeness prior as a broad lever** (below).
Per-category the constraint differs: single-hop is retrieval-limited (0.81 gold → 0.59 retrieved),
multi-hop is extraction+retrieval-limited (0.56 → 0.28), temporal is already HELPED by extraction
(atoms 0.62 > raw turns 0.32 — date-grounding paying off).

### Phase 2 — attack the measured gap — RE-SCOPED 2026-07-20 (post Phase-1)
Phase 1 measured the binding constraint; it is **not** broad extraction completeness. Re-scoped, in order:

1. **Single-hop retrieval (primary).** Largest category (n=70) with the clearest, in-scope headroom:
   0.81 (perfect evidence) → 0.59 (real retrieval) = **~0.23 recoverable** by surfacing the right atoms.
   The right atoms mostly EXIST (gold-atoms 0.60 ≈ retrieved 0.59 on single-hop) — this is a ranking/recall
   problem, not an extraction problem. Local-first-aligned.
2. **Multi-hop (secondary).** The ONE category where extraction completeness genuinely helps — it loses at
   both rungs (0.56 → 0.34 extraction → 0.28 retrieval). Repair-only atom triage (recall 78→80.1, typeAcc +9,
   currently disabled) is the evidence-backed lever HERE specifically, not as a global fix.
3. **Do NOT spend on temporal** — already near its evidence ceiling via text-surface date-grounding.
4. **Hard ceiling to respect:** any memory-pipeline work is bounded by the ~0.53 perfect-evidence ceiling.
   The dominant −0.42 lever (answerer capability) is explicitly OUT of scope (a stronger answerer is a
   rejected mechanism — reintroduces the harness confound). So the realistic reachable gain from Phase 2 is
   **~7 aggregate points** (extraction ~6 + retrieval ~1), concentrated in single-hop + multi-hop.

**Caveat before acting:** Phase-1 numbers are a single conversation, single day (n=152). Confirm the ceiling
at full-suite + ≥3 runs (Phase 3 rules) before committing build effort to Phase 2.

### Phase 3 — variance-lock + full-suite gate
Full-suite n=1986, ≥3-run, conversation-level baseline. Report median + dispersion + worst-conversation.
Only here does a "0.62" or "0.70" number become claimable.

## Do NOT (rejected mechanisms — reopening bar is real usage evidence, not a benchmark rerun)
Entity-relation graph traversal (WS3 killed it 2026-07-13) · FTS revival as a ceiling-raise (moves sideways:
+18.6% plain / −15.8% literal, FEAT-480) · a stronger answerer model (reintroduces the harness confound) ·
any chunk-size / temperature / maxTokens / sweeper-v1 A/B (all rejected).

## Methodology fixes this plan mandates
1. **Freeze the metric** — declare overall vs category-avg; report `--llm-judge` alongside F1 always.
2. **Archive per-question scores** — extend `archive-run.mts` so bootstrap CIs / paired tests are computable
   post-hoc (currently impossible from the on-disk `metrics.json`).
3. **Full-suite + ≥3 runs + conversation-level splits** before any claim; leave-conversation-out for answerer work.
4. **Same-day controls** for every A/B (±6-pt/day service variance).

## Provenance
Run data: `docs/eval-runs/`. Root-cause: `docs/research/20260713-single-hop-root-cause.md`. Rejected ledger:
`docs/research/20260714-locomo-hypothesis-ledger.md`. Cross-review: the 5 artifacts under
`.claude/artifacts/crew/reviews/` + `handoffs/` dated 2026-07-20. v1 (superseded):
`docs/research/20260719-locomo-0.70-research-for-cross-review.md`.
