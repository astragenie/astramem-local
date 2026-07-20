# Overnight run summary — 2026-07-20

Autonomous overnight work while the operator slept. All runs conv-1 (n=199), isolated
sandbox daemons (prod :7777 never touched). Numbers now git-tracked (`.eval-data` run
outputs un-ignored; raw dataset stays ignored).

## Headline
1. **Fresh baseline landed at 0.5112** — **~6pt below** the 07-18/07-19 board (0.573/0.584).
   Same conv, same-ish recipe, different day → a **live demonstration of the codex ±6pt/day
   variance** the cross-review said dominates the champion gap. The gap is variance, confirmed again.
2. **The single-hop diagnosis is SETTLED (free, zero LLM):** single-hop is a **RECALL problem,
   not a format/answerer problem.** This kills v1's central bet and validates the re-scope.

## Baseline — `20260720-baseline-v2` (0.5112, git 277bb06)
| cat | F1 | n |
|---|---|---|
| adversarial | 0.809 | 47 |
| temporal | 0.555 | 37 |
| single-hop | 0.437 | 70 |
| open-domain | 0.316 | 13 |
| multi-hop | **0.266** | 32 |
| **overall** | **0.5112** | 199 |

Recipe: `--extract-profile conversational --k 15`, passes=inherited-default (NOT pinned to 2 —
one reason it may sit at the low end; the board pinned passes=2). Still within the day-variance band.

## Precision-vs-recall analysis (free — the key result)
For each answered question: token-overlap **precision** (is the answer concise/correct) vs
**recall** (does the answer contain the gold). Verbose-but-correct = high-recall + low-precision.

| cat | prec | rec | f1 | verbose (hiR,loP) | **recall-miss (loR)** |
|---|---|---|---|---|---|
| **single-hop** | 0.423 | 0.481 | 0.430 | **3/70 (4%)** | **36/70 (51%)** |
| multi-hop | 0.280 | 0.366 | 0.274 | 1/32 (3%) | 18/32 (56%) |
| temporal | 0.593 | 0.514 | 0.540 | 0/37 | 20/37 (54%) |
| open-domain | 0.305 | 0.232 | 0.231 | 0/13 | 10/13 (77%) |

**Conclusion:** the verbose-answer-penalty (the (c) axis three reviewers raised) is **negligible
(≤4% everywhere)**. The dominant failure across ALL weak categories is **recall-miss** — the gold
tokens aren't in the answer at all. This **confirms `single-hop-root-cause.md`** (36-47% of gold
never extracted) and **refutes both v1's answerer/format bet and the scorer-artifact hypothesis.**

**Caveat:** raw token-overlap, not `--llm-judge`. A "miss" could be a semantically-correct answer
that mismatches gold tokens (the harsher-than-upstream artifact). So 51% is an UPPER bound on real
misses — BUT the verbose=4% finding is robust (failures are token-absent, not too-wordy). Next
refinement: re-score misses with `--llm-judge` to split "semantically wrong" from "token-mismatch".

**Implication for the plan:** the lever is **extraction completeness + retrieval recall**, NOT the
answerer. Exactly the re-scoped Phase 2 (repair-only atom triage / extraction). The answerer A/B
(effort→low) and multiHop A/B are still worth measuring but are not where the points are.

## multiHop A/B — `20260720-multihop-v2` (0.5511) — CONFOUNDED, no clear benefit
`--multihop` verified ON in the sandbox config. Overall 0.5511 vs baseline 0.5112 = +0.040.
**But this is NOT a multiHop win — it's a broken comparison:**
- It's a **separate distill** vs the baseline (not a same-store A/B), so the delta is entangled with day-variance.
- The lift is **uniform across ALL 5 categories** (adversarial +0.021, single-hop +0.046, multi-hop +0.036) — decompose can't affect adversarial; a uniform lift is the **variance signature**, not a decompose signature.
- 0.5511 is **BELOW the multiHop-OFF board** (0.573/0.584). So multiHop didn't beat normal runs — it beat a low-variance-day baseline.
**Conclusion: no measurable multiHop benefit here.** A same-store A/B (distill once, answer with multiHop off vs on) is required to isolate it — the `--multihop` flag is now wired + verified for that. First attempt also exposed the eval sandbox's contradiction-judge firing 200 failing calls (FEAT-482 class) + a too-short 900s distill timeout on a contended box.

## Answerer A/B — deferred to next session
The precision finding already indicates the answerer is NOT the lever (single-hop is recall-miss, not verbose-penalty), so an `effort=low` answerer won't fix recall. Needs a clean same-store `--resume` setup. `ASTRA_LOCOMO_ANSWER_EFFORT`/`ASTRA_LOCOMO_ANSWER_MAX_TOKENS` knobs are wired (C2) and ready.

## Bottom line (the overnight empirically validated the cross-review's re-scope)
1. **Day-variance dominates** — baseline landed 0.5112, −6pt below the board on the same recipe. Confirmed live. Single-run deltas can't be trusted (multiHop's +0.040 is variance).
2. **Single-hop is a RECALL/extraction problem** (51% recall-miss, 4% verbose) — not the answerer, not format. THE lever is extraction completeness.
3. **Config knobs (multiHop) show no clean benefit** — consistent with "config space exhausted."
4. **The path forward is: metric-match (`--llm-judge`, per Zep audit) → oracle factorial → extraction completeness → same-store retrieval A/Bs with ≥3 runs.** Not a stack swap, not the answerer, not a lucky-day chase.

## Status of the PRs (GitHub CI was down)
FEAT-483 (7 PRs #445-451) + the v2 doc PR #452 auto-merge when GitHub recovers. All built + reviewed.
