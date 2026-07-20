# Oracle factorial — the honest per-stage LoCoMo ceiling (2026-07-20)

**Diagnostic, not a published score.** Single conversation (conv-26), n=152 cat1-4,
one codex/Azure day. Answers the v2 plan's Phase-1 question: *where does the LoCoMo
gap actually live* — extraction, retrieval, evidence-sufficiency, answering, or scoring —
by answering every question from 4 evidence sources × 2 answerers and judging each cell
identically. Harness: `scripts/eval/locomo/oracle/`. Raw table: `factorial.md` / `factorial.json`.

## The table (llm-judge cat-avg, token-F1 in parens; best answerer per row bolded)

| evidence source | canonical | current | best | vs Zep 0.947 |
|---|---|---|---|---|
| **gold-turns** — the exact cited source turns (perfect evidence) | **0.526** | 0.502 | **0.526** | −0.421 |
| gold-atoms — distilled from *only* the gold turns | 0.452 | 0.468 | 0.468 | −0.479 |
| retrieved-atoms — the **real pipeline's** search results | 0.461 | 0.446 | 0.461 | −0.486 |
| retrieved-spans — retrieved atoms mapped back to source turns | 0.456 | 0.447 | 0.456 | −0.491 |

**Faithfulness check:** the `retrieved-atoms` cell (0.461) reproduces the independent P0a
llm-judge rescore of the real baseline-v2 pipeline (0.463, see LEDGER) to within noise —
the oracle harness measures the same thing the real eval does, so the rungs above it are trustworthy.

## Attribution — the headline

Reading the ladder top-down (each rung strips one stage's perfection):

```
gold-turns   0.526   ceiling: PERFECT evidence + current answerer + LoCoMo scorer
  │  −0.058          EXTRACTION loss  (raw gold turns → atoms)
gold-atoms   0.468
  │  −0.007          RETRIEVAL loss   (gold atoms → what search actually surfaces)
retrieved    0.461   the real pipeline
  ⋮  −0.421          ANSWERER + SCORER + gold-evidence-sufficiency ceiling
Zep target   0.947
```

**~87% of the gap to Zep (0.42 of 0.49) is downstream of the memory pipeline** — it is the
ceiling of the cheap answerer + the LoCoMo scorer + how answerable LoCoMo's own cited
evidence is. Extraction costs ~6 pts; retrieval costs ~1 pt. **Handed the literal answer
turns, the current answerer+scorer still tops out at 0.53.** This directly tests — and
largely refutes — the v2 plan's Phase-2 prior that *extraction completeness* is the binding
constraint. Within astramem's local-first frame, extraction+retrieval together are worth at
most ~7 aggregate points before hitting the 0.53 evidence-perfect ceiling.

## Per-category — the constraint is NOT uniform

The aggregate hides that different categories are bottlenecked at different stages (llm-judge,
best answerer per cell):

| category (n) | gold-turns | gold-atoms | retrieved | reading |
|---|---|---|---|---|
| single-hop (70) | **0.814** | 0.600 | 0.586 | **retrieval-limited** — 0.23 headroom gold→retrieved; biggest category |
| multi-hop (32) | 0.563 | 0.344 | 0.281 | extraction **and** retrieval limited — degrades hard at every rung |
| temporal (37) | 0.324 | **0.622** | 0.595 | extraction **HELPS** (+0.30): atom date-grounding beats raw turns; retrieval fine |
| open-domain (13) | 0.385 | 0.308 | 0.462 | n=13, ±27pt half-width — unusable, ignore |

- **single-hop** (the largest category) has real, targetable retrieval headroom.
- **multi-hop** loses at both extraction and retrieval — the one category where extraction
  completeness would genuinely help.
- **temporal** is already near its evidence ceiling *because of* extraction — the text-surface
  date-grounding work (PR #189/#191) is paying off; raw turns answer temporal *worse* than atoms.

## Answerer axis (canonical vs current) — scorer artifact is small

`canonical` (minimal judge-friendly render) vs `current` (the real benchmark answerer) differ
by only ~1–2 pts, and not even consistently in one direction (canonical > current on gold-turns,
< current on gold-atoms). **The ~0.53 ceiling is real, not a phrasing/metric mirage** — a
better answer *format* does not unlock the gap.

## Caveats (why this is a diagnostic, not a number to publish)

1. **n=152, one conversation, one day.** Per the eval-runs measurement rules, needs full-suite
   (n=1986) + ≥3 runs + conversation-level splits before any of these numbers is claimable.
2. **gold-turns may still slightly understate the true evidence ceiling.** ~33% of gold evidence
   is image-caption-grounded; captions are now folded in (mirrors `lib/envelope.ts:51`), but some
   captions still don't ground their question's answer, and some cat-1 questions cite a single
   dia_id when answering needs cross-referencing. Both cap gold-turns below a theoretical 1.0
   independent of astramem.
3. **retrieved-spans is a weak rung.** Only 25.3% of retrieved atoms' `evidence` quotes resolve
   back to a source turn (75% fall back to atom text), so retrieved-spans ≈ retrieved-atoms and
   adds little signal. The low match rate is itself a finding: extracted `evidence` quotes are
   not reliably verbatim-substring-present in the source turns.

## What this says for Phase 2

- The dominant lever (the 0.42 answerer/scorer/sufficiency chunk) is **explicitly out of scope**
  under the plan's local-first constraint (a stronger answerer was rejected as a harness confound).
- The reachable memory-pipeline gain is bounded (~7 pts) and concentrated: **single-hop retrieval**
  (largest category, clearest headroom) and **multi-hop** (the only category where extraction
  completeness clearly helps). Temporal is already near-ceiling — do not spend there.
- Do **not** pursue broad "extraction completeness" as a general lever — the factorial shows it is
  net-neutral-to-helpful aggregate, only material for multi-hop.

## Reproduce

```bash
bun scripts/eval/locomo/oracle/oracle-factorial.mts \
  --datadir .eval-data/locomo/runs/20260720-baseline-v2/datadir --k 15 \
  --out <out-dir>
# gold-turns / gold-atoms need no store; retrieved-* mount a daemon on --datadir.
# --sources / --answerers / --limit-questions to slice; --cells for a single cell.
```

---

# Follow-up (2026-07-20): the answerer + judge ceiling

The factorial above ran with the frozen cheap stack (reader = gpt-5-mini `minimal`,
judge = gpt-5-mini one-word yes/no). Two follow-up experiments isolated how much of the
gap-to-Zep is that MEASUREMENT stack vs a real memory deficit. Zep's published 94.7% uses
**reader = gpt-5.4 (medium) + judge = gpt-5.4 chain-of-thought**; we reproduced both halves.

## Reader ladder (llm-judge cat-avg, n=152, judge held at gpt-5-mini)

| source | current (gpt-5-mini) | strong (gpt-4o) | zep-match (gpt-5.4 med) |
|---|---|---|---|
| gold-turns (perfect ev.) | 0.502 | 0.417 | 0.535 |
| retrieved-atoms (pipeline) | 0.461 | 0.400 | 0.426 |

**A stronger reader alone does NOT lift the score** — gpt-4o is *worse* (verbose output meets a
lexical-ish judge), gpt-5.4 barely moves. Eyeballing showed the readers produce correct answers
whenever the evidence contains the fact; the failures are evidence-insufficiency + judge harshness,
not the reader. This refuted the initial "stronger reader closes the gap" hypothesis.

## Judge swap — same gpt-5.4 hypotheses, re-scored with a gpt-5.4 CoT judge (`rejudge.mts`)

| cell (gpt-5.4 reader) | gpt-5-mini judge | gpt-5.4 CoT judge | overall (CoT) |
|---|---|---|---|
| gold-turns (perfect ev.) | 0.535 | **0.669** | **0.750** |
| retrieved-atoms (pipeline) | 0.426 | **0.501** | **0.566** |

**The judge was the bigger suppressor** (+0.134 gold / +0.075 retrieved cat-avg, > the reader swap).
Our gpt-5-mini yes/no judge marks paraphrased/date-resolved-correct answers wrong.

## The honest decomposition (overall/micro, Zep-comparable, Zep's full stack)

```
0.566  our real pipeline, gpt-5.4 reader + CoT judge   ← the FAIR product number (not 0.46/0.53)
  +0.184  retrieval headroom  (right atoms exist below top-k / not surfaced — IN SCOPE)
0.750  perfect evidence (gold-turns), same stack        ← ceiling with LoCoMo's OWN cited turns
  +0.197  residual to Zep
0.947  Zep reported
```

The last +0.197 is on PERFECT evidence, so it is **not** our extraction/retrieval:
1. **Evidence-sufficiency** — LoCoMo's cited gold turns often don't contain the answer (~33% image-
   caption-grounded; single-dia_id multi-hop needing other turns). Many "wrong" answers are correct
   abstentions on insufficient cited evidence.
2. **Zep retrieves richer context than the single cited turn** (their multi-scope graph surfaces
   neighbors) — an architecture difference, not a memory-quality deficit. See the `retrieved-multiscope`
   prototype (below / separate run) testing whether neighbor expansion recovers the retrieval headroom.

## Verdict for the "product is broken at 0.53" question

- **~⅓ of the apparent gap was MEASUREMENT** — a harsh cheap judge under-scored us by ~10pt. The fair
  number for our pipeline (real reader + fair judge) is **0.57 overall**, not 0.46/0.53.
- **~0.18 overall is real retrieval headroom** (single-hop: retrieved 0.643 vs gold 0.843 under CoT) —
  the in-scope, local-first lever.
- **~0.20 is evidence-sufficiency + Zep's multi-scope retrieval** — partly the benchmark's own citation
  quality (not our bug), partly a stealable architecture idea.
- LoCoMo is a CONVERSATIONAL benchmark; for the actual product (coding-agent memory) it is not even the
  right test. 0.95 is not the bar.

## Harness added
`answerers/strong.mts` (gpt-4o), `answerers/zep-match.mts` (gpt-5.4 medium), `rejudge.mts` (gpt-5.4 CoT
re-score of cached hypotheses), `sources/retrieved-multiscope.mts` (PRF neighbor-expansion retrieval).
gpt-5.4 was provisioned on the Azure resource (GlobalStandard, consumption-billed) for these runs.
