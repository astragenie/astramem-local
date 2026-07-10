---
status: needs_fix
---

# Review Result — SLICE-423 / FEAT-457 slice 1 (LoCoMo judge multi-run mean±stdev)

- Worktree: `C:\work\mega\astramemory-local-worktrees\w457s1`, branch
  `feat/feat-457-multirun-stats`, commit `10290b5` vs `main`/`75c2056` (v0.13.0)
- Reviewer: independent review (read-only, no edits made, worked only in this worktree)
- **Verdict: NEEDS_FIX** — one MEDIUM-HIGH finding: `judge.mts`'s new multi-run
  `--run-dir` aggregation has no guard against combining run dirs sampled with
  different `--dataset`/`--seed`/`--n`/`--qa-per-sample`, reintroducing the exact
  "silently publish a dishonest/meaningless number" risk class FEAT-462a just
  closed for single-run `--resume`, one layer up the pipeline. Everything else —
  the stats math itself, backward compatibility, the `stats.ts` promotion, and the
  AC-1/2/3/5 citations — is genuinely correct, verified directly (including a live
  execution diff against the pre-slice commit), not just trusted from the handoff.

## 1. Stats correctness — mean-of-run-means confirmed, correctly labeled; hand-verified myself

Read `combineMetricsReports` directly: for each category it calls `computeStats(reports.map(r => r.per_category[c].accuracy))` — i.e., it feeds each **run's own already-averaged accuracy** for that category into `computeStats`, not the pooled per-question scores. This is genuinely **mean-of-run-means**, the honest run-to-run-variance statistic (matches the extraction-bench precedent, `combineRuns`) — not a pooled-per-question calculation that would understate true run-to-run noise. Confirmed the same for `category_averaged_accuracy_stats` and `overall_accuracy_stats` (both computed over the array of each run's own scalar value). `n_total` and each category's `n`, by contrast, are correctly **summed** (pooled QA counts), and `printMultiRunReport`'s banner (`n=${report.runs.length} runs, mean ± stdev`) accurately labels what's being aggregated — no mismatch between what's computed and what's claimed.

**Hand-verified the shipped fixture test's math myself, not just re-run it**: category 4 (accuracies [0.5, 1.0]) → mean 0.75, sample stdev (n-1 denominator) √0.125 — recomputed by hand, matches. Category 5 ([1, 0]) → mean 0.5, stdev √0.5 — matches. `category_averaged_accuracy` per-run values [0.75, 0.5] → mean 0.625, stdev √0.03125 — matches. `overall_accuracy` identical across both runs (2/3 each) → stdev exactly 0 — matches. `n_total` = 3+3 = 6 — matches. All five hand-computed values check out exactly against what the test asserts.

## Finding 1 (MEDIUM-HIGH — real, verified): no cross-run sampling-scope guard on `judge.mts --run-dir`, unlike the closely analogous FEAT-462a guard shipped right next to this code

**File: `scripts/eval/locomo/judge.mts:151-181`.** The multi-run branch reads
`hypotheses.jsonl` + `sample.json` from each `--run-dir` and combines them via
`combineMetricsReports` with **zero comparison** of the sampling parameters (dataset,
seed, `--n`, `--qa-per-sample`) that produced each run dir. Confirmed by reading the
whole file: there is no import of, or reference to, `run-params.json`/
`evaluateResumeGuard` anywhere in `judge.mts`, even though `../shared/run-params.ts`
(the exact machinery FEAT-462a just built for precisely this class of risk) already
exists in this same repo, one directory over.

**Why this matters, stated as concretely as FEAT-462a's own finding was**: an
operator who runs `run.mts` three times into three different run dirs — say, once
with `--n 20` (a quick smoke check) and twice with the full `--n` for real scored
runs — and then, by habit or copy-paste error, points `judge.mts --run-dir` at all
three, gets a confidently-printed mean±stdev report with **no warning that the runs
weren't comparable**. The resulting "mean ± stdev" is mathematically well-defined but
substantively meaningless (averaging a smoke-test run's accuracy in with two real
runs), silently laundered into what looks like a legitimate multi-run statistical
summary — the same "quietly narrows/changes scope, looks fully successful" failure
shape FEAT-462a's review explicitly named and blocked on, just one stage later in
the same pipeline (aggregation across runs, rather than resume of a single run).

The `scripts/eval/locomo/README.md`'s new "Multi-run" section **does** instruct the
operator to "repeat the **same** invocation (same `--dataset`/`--seed`/`--n`/
`--qa-per-sample`)" — so this is disclosed, not silent-by-omission at the
documentation level — but it is purely advisory prose with no enforcement, unlike
FEAT-462a's `evaluateResumeGuard`, which actively refuses on mismatch. Given AC-6 (the
real published-number step) is the direct downstream consumer of exactly this
aggregation path, and is explicitly gated on this slice being done first, I'm calling
this a genuine finding rather than "acceptable with a README warning" — the project's
own track record (this exact multi-slice effort) has already set the bar that this
class of risk gets an enforced guard, not just a documented expectation, and the
infrastructure to do so here is already sitting in the same repo, one import away.

**Recommended fix (cheap, reuses existing infrastructure)**: when combining multiple
`--run-dir`s, read each dir's `run-params.json` (written by `run.mts`, per
FEAT-462a) if present, and refuse (or at minimum loudly warn) if they don't all
match — mirroring `evaluateResumeGuard`'s existing comparison logic rather than
inventing new logic. A run dir with no `run-params.json` (pre-462a) could reasonably
warn-and-proceed rather than hard-refuse, since multi-run combination is a new,
opt-in feature (not the default `--resume` path 462a hard-gates). Recommend closing
this before FEAT-457's AC-6 (the actual publish step) is executed, since that's the
step whose output this specific gap could taint.

## 2. Empty/degenerate handling — mathematically safe; one low-severity observability nit found

Traced `computeMetrics`'s NaN handling (`accuracy = scores.length > 0 ? ... : NaN`)
through `computeStats` (`shared/stats.ts`), which filters non-finite values before
computing mean/stdev — confirmed a category empty in **every** run correctly
resolves to `mean: null` (not a crash, not a fabricated 0), matching the shipped
test's own assertion for category 1 (n=0 in both fixture runs).

**Constructed the asymmetric case myself** (not covered by the shipped tests): a
category populated in run 1 but empty in run 2. Result: `computeStats` correctly
filters to the one finite value, giving `mean` = that run's own accuracy and
`stdev: null` (fewer than 2 finite values — correctly no fabricated variance). No
NaN leaks into the printed report or the serialized JSON in any case I tried.

**One low-severity, non-blocking observability nit**: `printMultiRunReport` prints
`report.per_category[c].n` (the **pooled QA count** across all runs) next to each
category's mean±stdev line, not `category_stats[c].accuracy.n` (the **count of runs
that actually had data for that category**). In the asymmetric case above, this
prints e.g. `single-hop: 50% (2)` — a bare percentage with no `±`, which IS an
implicit signal that a full N-run stdev wasn't available, but the printed `(2)`
reads as a QA count, not as "only 1 of 2 runs contributed." Not a correctness bug —
no bad number is ever shown — just a minor clarity gap for a reader trying to
understand why one category lacks a `±` term when the banner says "n=2 runs."
Low priority given LoCoMo's fixed, small 10-conversation dataset makes this a fairly
narrow edge case in practice (would require a category losing all its questions to
distill timeouts in one run specifically).

## 3. `stats.ts` promotion — history preserved, no behavior drift, pre-existing breakage correctly disclosed as out-of-scope

`git log --follow -- scripts/eval/shared/stats.ts` correctly traces the file's
history back through the `git mv` to its original location and the FEAT-450 commit
that created it — rename detection worked, history is not lost. Diffed all three
updated extraction-bench import sites (`lib/judge.ts`, `lib/report.ts`,
`run-bench.mts`): each changes only the import path string, nothing else — matches
"path-only diff" claim exactly.

**Verified the handoff's own "incidental finding" claim directly** (a self-reported,
out-of-scope pre-existing breakage): confirmed via `git show 75c2056:scripts/eval/
extraction-bench/lib/judge.ts` that the broken `../../longmemeval/lib/{azure-client,
config}.js` imports already existed **before** this slice's own commit (that
directory only contains `dataset.ts`/`dates.ts`/`envelope.ts`/`types.ts` today — the
daemon-plumbing tier moved to `shared/` as part of the FEAT-457 harness landing,
`480d870`, which predates this slice). Also confirmed every reference to
`judge.ts` from a file that actually runs under the test suite is `import type`
only (`report.ts` and `report.test.ts` both use `import type`), so this
pre-existing breakage genuinely cannot surface in `bun run test` today, matching
the handoff's own honest characterization — not something this slice is responsible
for or should have fixed.

## 4. Single-run backward compat — verified with a live execution diff, not just a code-reading inference

Built a small fixture (2-QA sample + matching hypotheses.jsonl) and ran
`judge.mts --hyp/--ref` against it at **both** commits via a throwaway comparison
worktree at `75c2056` (removed afterward): stdout output is byte-for-byte identical
apart from the (intentionally different) `--out` filename echoed at the end, and the
written `metrics.json` files diff to nothing. This is a genuine executed comparison,
not an inference from reading the diff (though the diff itself also confirms it: the
removed single-run code block and the new `else`-branch single-run code are
textually identical, just re-indented one level).

## 5. AC citation honesty — spot-checked, accurate

- **AC-1**: confirmed `judge.mts` imports `azureChatComplete`/`resolveAzureConfig`
  from `../shared/` — at `75c2056` (the commit these lines describe as "pre-existing")
  they sat at exactly lines 27-28 as cited; they've since shifted to ~40-41 in the
  current file purely because this slice added new doc-comment lines earlier in the
  file — a harmless, explainable line-number drift, not a fabricated citation.
  Confirmed `ls scripts/eval/locomo/` vs `ls scripts/eval/shared/` shows zero
  filename overlap — no shared-tier file is duplicated under `locomo/`.
- **AC-3**: confirmed `spawn-daemon.ts` sets `ASTRA_MEMORY_DATADIR: opts.dataDir` in
  the spawn env, and `run.mts` calls `spawnEvalDaemon({ dataDir, token, env:
  isolated.env })` — both citations check out at the cited locations.
- **AC-2**: confirmed `.gitignore:27` is `.eval-data/`, and the LoCoMo README's
  License section (CC BY-NC 4.0 attribution) is present and intact.
- **AC-5**: confirmed via the gate run below — all six named LoCoMo unit suites are
  part of the passing `scripts/eval/` run, pure/fixture-based, no live network.

## 6. Gates — re-run independently, matches builder's numbers exactly

- `bunx tsc --noEmit`: clean, no output.
- `bunx vitest run scripts/eval/`: **13 files / 113 tests passed, 0 failed.**
- `bun run test` (full suite, in-worktree): **204 files / 2427 tests passed, 6
  skipped, 0 failed.**

## Recommendation

Fix Finding 1 before FEAT-457's AC-6 (the actual publish step) runs — reuse
`../shared/run-params.ts`'s existing comparison logic in `judge.mts`'s multi-run
branch rather than inventing new machinery; this is cheap given the infrastructure
already exists, and it directly protects the one thing this whole multi-slice effort
(FEAT-461 → FEAT-465 → FEAT-466 → FEAT-462a → FEAT-457) has been building toward: a
number worth publishing. The observability nit in section 2 is real but low priority,
not a blocker. Everything else in this slice — the stats math (independently
hand-verified), backward compatibility (verified via a live execution diff, not just
a diff read), the `stats.ts` promotion's history preservation and clean import
updates, and the AC-1/2/3/5 citations — is genuinely correct and well-tested.
