---
id: FEAT-450
status: in-progress
priority: P2
category: platform
target_release: null
created: 2026-07-09
depends_on: []
blocks: []
slices: []
derived_from: 2026-07-09 extraction model/prompt eval (noise dominated all deltas)
autonomous_safe: true
tags: [concern:eval, concern:quality, surface:eval, stack:typescript, followup]
triage_notes: "The extraction-bench (scripts/eval/extraction-bench) cannot resolve extraction-quality deltas under ~15 F1 because each config is run ONCE, over only 15 gold fixtures, judged by a single non-deterministic gpt-5-mini (reasoning_effort=minimal). Evidence from 2026-07-09: qwen2.5:7b scored 50/53/58/59/61/61/67/72 F1 across runs on near-identical configs (±14 swing). Every prompt (v1/v2/v2.1) and temperature (0/0.1) a/b landed inside that band → indistinguishable from noise. So model/prompt/temp tuning is currently impossible — we can only separate big cloud models (azure 81, codex 71) from the local ~50-72 band. This blocks any real prompt/temp iteration (the ASTRA_EXTRACT_PROMPT / ASTRA_EXTRACT_TEMP selectors landed but can't be evaluated). Bench-script-only change, reversible, low risk — autonomous_safe."
---

> **STATUS 2026-07-09 — code merged to main, verification-blocked (NOT done).**
> Implementation merged (commit range incl. `27bbf82`, scripts/eval/extraction-bench only):
> `--runs N` multi-run mean±stdev; significance gate (`compareMeans`, noise floor
> = 2×√(sA²/nA+sB²/nB)); 15→42 gold fixtures; judge reasoning-effort minimal→low +
> `judgeSelfAgreement`; backward-compatible at `--runs 1`. New `lib/stats.ts`,
> `lib/report.ts` + 26 unit tests (green), root `tsc` clean, live `--runs 2` Ollama smoke passed.
>
> **Remaining before close (ACs 3 & 4 empirical):** run a live judged sweep once
> Azure is available — `az login`, then `--runs 8` over the 42 fixtures — and confirm
> (AC-3) 42-fixture per-run F1 stdev < the ~7.1 F1 15-fixture baseline, and (AC-4)
> judge self-agreement is reported. Blocked 2026-07-09 by expired `az` session
> (AADSTS50132). Mechanism built + unit-tested; only the empirical measurement is pending.

# FEAT-450: harden extraction-bench so prompt/temp/model tuning is statistically possible

## Problem

`scripts/eval/extraction-bench` produces F1 numbers too noisy to act on. Single
run per config + 15 fixtures + one non-deterministic gpt-5-mini judge
(reasoning_effort=minimal) gives a **±14 F1 run-to-run swing on the same model**
(qwen2.5:7b: 50/53/58/59/61/61/67/72 across the 2026-07-09 runs). Result: the
prompt-v2/v2.1 and temp-0 a/b deltas were all inside the noise → no reliable
call possible. The `ASTRA_EXTRACT_PROMPT` / `ASTRA_EXTRACT_TEMP` selectors exist
but can't be meaningfully evaluated until the bench separates signal from noise.

## Requested capability

Make the bench able to detect real deltas (target: resolve ~5 F1 differences):

1. **Multi-run averaging** — run each config N times (default 3, configurable
   `--runs N`), report **mean ± stdev** per metric, not a single sample.
2. **Significance gate** — do not declare A > B unless the mean delta exceeds a
   noise floor (e.g. `> k * pooled_stdev`, or a simple paired test across the
   per-fixture scores); print "within noise" otherwise.
3. **More fixtures** — expand the gold set from 15 toward 40+ (more diverse
   real-work chunks) so per-run variance drops.
4. **Judge stability** — reduce judge noise: raise the judge's reasoning effort,
   and/or majority-vote across ≥3 judge samples per fixture, and/or pin a
   deterministic scoring rubric. Measure and report judge self-agreement.

## Acceptance criteria

- AC-1 (multi-run + variance): Given `--runs 3` on one model, When the bench
  completes, Then the report shows mean ± stdev for recall/precision/F1/type-acc
  across the runs (not a single value), and per-config raw runs are retained.
- AC-2 (significance gate): Given two configs whose mean F1 differ by less than
  the computed noise floor, When the report is generated, Then it labels the
  comparison "within noise / not significant" rather than ranking them; a delta
  above the floor is labeled significant.
- AC-3 (fixture expansion): Given the gold fixture set, When counted, Then it
  contains >= 40 fixtures spanning the existing difficulty/topic mix, and the
  measured per-run F1 stdev on a fixed model is lower than the 15-fixture
  baseline (report both).
- AC-4 (judge stability): Given the judge, When a fixture is scored, Then either
  the judge runs at a higher reasoning effort or majority-votes >= 3 samples,
  and the bench reports judge self-agreement (variance of the same fixture
  re-judged) so judge noise is visible.
- AC-5 (regression-free): Given `--runs 1` (default), When run, Then behavior is
  backward-compatible with today's single-run report shape.

## Refs

- Bench: `scripts/eval/extraction-bench/run-bench.mts`, `lib/judge.ts`, `fixtures/`.
- Selectors that need this to be evaluable: `src/distill/stages/05-extract.ts`
  (`ASTRA_EXTRACT_PROMPT`, `ASTRA_EXTRACT_TEMP`), `EXTRACTION_SYSTEM_PROMPT_V2`.
- Prior eval data (the noise evidence): 2026-07-09 runs under
  `scripts/eval/extraction-bench/results/` (ab-run/real-run 2026-07-08 committed).
