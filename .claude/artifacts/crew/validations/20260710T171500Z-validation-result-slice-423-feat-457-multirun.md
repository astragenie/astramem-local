---
status: PASS
---

# Validation Result — SLICE-423 / FEAT-457 slice 1 (LoCoMo judge multi-run mean±stdev)

Worktree: `C:\work\mega\astramemory-local-worktrees\w457s1`, branch `feat/feat-457-multirun-stats`
(head `8436f08` + docs commit, not switched, no source edits made). Review PASS after 1 fix
round, round 2 already executed the CLI live for the refuse/proceed/annotation cases against the
reviewer's own fixtures. This pass is independent confirmation using an independently-designed
fixture set, plus the one sanity check (single `--run-dir` with no `run-params.json`) neither
review round specifically exercised.

`bun install` (no changes) + `bun run build` (`tsc -p .`): clean. `judge.mts` is pure offline
scoring — no daemon spawned, no live LLM, matching the task's stated scope.

## Scenario 1 — Multi-run happy path, verified against my own independent hand computation

Built 3 fixture run dirs (`runA`/`runB`/`runC`), each with an **identical** `run-params.json`
(same `datasetPath`/`datasetHash`/`seed`/`n`/`qaPerSample`/`shards`) and a shared
`sample.json` (one LoCoMo conversation, 3 QA pairs: one category-4 single-hop question with
reference answer "Paris", two category-5 adversarial questions). Deliberately chose hypotheses
whose scores are exactly computable by hand:

| run | cat-4 hypothesis (ref "Paris") | cat-4 score | cat-5 hyp 1 | cat-5 hyp 2 | cat-5 scores |
|---|---|---|---|---|---|
| A | "Paris" (exact match) | 1.0 | "not mentioned in the text" | "no information available" | 1, 1 |
| B | "London" (no overlap) | 0.0 | "not mentioned" | "I think it was pizza" | 1, 0 |
| C | "Paris" | 1.0 | "Hawaii" | "pizza" | 0, 0 |

**My hand computation** (sample stdev, n-1 denominator, matching `shared/stats.ts`):
- category 4 per-run accuracies [1, 0, 1] → mean = 2/3 ≈ 0.6667, stdev = √(1/3) ≈ 0.5774
- category 5 per-run accuracies [1.0, 0.5, 0.0] → mean = 0.5, stdev = √0.25 = 0.5
- category-averaged per-run [1.0, 0.25, 0.5] → mean = 7/12 ≈ 0.5833, stdev ≈ 0.3819
- overall per-run [1.0, 0.3333, 0.3333] → mean = 5/9 ≈ 0.5556, stdev ≈ 0.3849
- n_total = 3 QAs × 3 runs = 9

**Ran the real CLI**: `bun scripts/eval/locomo/judge.mts --run-dir runA --run-dir runB --run-dir
runC`:
```
LoCoMo results by category (n=3 runs, mean ± stdev):
	1 (multi-hop): — (n=0, 0/3 runs)
	2 (temporal): — (n=0, 0/3 runs)
	3 (open-domain): — (n=0, 0/3 runs)
	4 (single-hop): 67% ± 58% (n=3)
	5 (adversarial): 50% ± 50% (n=6)

Category-averaged accuracy: 58% ± 38%
Overall accuracy (F1/token-overlap, category 5 binary): 56% ± 38% (n=9)
```
Exit 0. **Every printed value matches my hand computation exactly** (67%↔0.6667, 58%↔0.5774,
50%/50%↔0.5/0.5, 58%/38%↔0.5833/0.3819, 56%/38%↔0.5556/0.3849, n=9). Also inspected the written
`metrics.json` at full float precision: `0.6666666666666666`, `0.5773502691896258`, `0.5`,
`0.5833333333333334`, `0.3818813079129867`, `0.5555555555555555`, `0.3849001794597505` — exact
fraction matches (2/3, √(1/3), 1/2, 7/12, etc.), and each run's own `per_category`/
`category_averaged_accuracy`/`overall_accuracy` in the `runs` array matches my per-run table
exactly. Categories 1-3 (empty in all three runs) correctly show `mean: null` and print `—` with
the `0/3 runs` annotation, matching the review's independently-confirmed empty-handling.

## Scenario 2 — Single `--run-dir`, no `run-params.json`

Built a 4th dir (`runD-nopars`) with `sample.json` + `hypotheses.jsonl` (copied from `runA`'s
data) but **no** `run-params.json` at all. Ran:
```
bun scripts/eval/locomo/judge.mts --run-dir runD-nopars --out single-rundir.metrics.json
```
Exit 0 — proceeds without any guard error, confirming `evaluateMultiRunParamsGuard`'s
`runDirs.length <= 1` short-circuit (verified by reading `run-params.ts:149`) fires correctly:
the guard is never even consulted for a single dir, so a missing `run-params.json` is a non-issue
in this path (as designed — the hard-refuse-on-missing-file behavior is specific to the 2+-dir
combine case).

Output uses the old single-run print shape (`LoCoMo results by category:` — no "mean ± stdev"
suffix, bare `1.0000`/`n/a` format via `printMetricsReport`, not the percentage-based
`printMultiRunReport`/`formatStatsPct`). Ran the equivalent `--hyp`/`--ref` invocation directly
against the same two files and diffed the two written `metrics.json` outputs: **`diff` exit 0,
byte-identical** — confirms the single-`--run-dir` path is genuinely equivalent to the pre-AC-4
`--hyp`/`--ref` path for the same underlying data, not merely similar-looking.

## Scenario 3 — Mixed dirs, one param-mismatched

Built a 5th dir (`runE-mismatch`) with the same sample/hypotheses data as `runB` but a
`run-params.json` differing only in `seed` (999 vs the A/B/C set's 42). Ran:
```
bun scripts/eval/locomo/judge.mts --run-dir runA --run-dir runE-mismatch
```
```
refusing to combine --run-dir runs -- these run dirs were NOT sampled with the same params
(combining them would produce a mean/stdev across substantively different runs, not honest
run-to-run variance):
  <runE-mismatch path>: seed differs (<runA path>=42, <runE-mismatch path>=999)
Only combine run dirs produced by the identical --dataset/--seed/--n/--qa-per-sample/--shards
invocation.
```
Exit 1. Names the offending dir (`runE-mismatch`) and the specific differing param with both
values (42 vs 999), matching the guard's documented behavior exactly. No output file was written
by the refused attempt (confirmed: no new `*.metrics.json` appeared).

## Incident during setup (self-caught, no lasting impact)

While constructing Scenario 3's mismatched fixture, a `node -e` one-liner intended to write a
**new** `run-params.json` for `runE-mismatch` was initially pointed at `runB`'s own
`run-params.json` path by mistake, setting `runB`'s `seed` to `999` in place. Caught immediately
by inspecting `runB/run-params.json` right after; restored it to `seed: 42` and re-ran Scenario 1
end-to-end to confirm the fixture set was fully intact again — the re-run's `metrics.json` output
diffed byte-identical (`diff` exit 0) against the original Scenario 1 run captured before the
mistake, confirming no corruption persisted into the evidence trail. `runE-mismatch`'s own
`run-params.json` was then written correctly, independent of `runB`.

## Cleanup / hygiene check

`git status` in the worktree shows two pre-existing, uncommitted items
(`.claude/artifacts/crew/reviews/20260710T162056Z-...md` modified, `vitest-results-scratch.json`
untracked) — both confirmed via `Get-Item` timestamps to predate this validation session
(12:07 PM and 11:47 AM respectively, before this session's first command), so they are leftover
from the review round's own work, not introduced by this validation. No files under `scripts/`
or `src/` were touched. All fixtures and driver invocations lived under the session scratchpad;
no daemon was spawned (`judge.mts` is pure offline scoring, as expected).

## Overall

**PASS.** Independent hand computation matches the real CLI's printed and full-precision JSON
output exactly for the multi-run happy path. Single-`--run-dir` (no `run-params.json`) correctly
bypasses the guard and produces byte-identical output to the legacy `--hyp`/--ref` path — the one
sanity check not previously exercised live. The param-mismatch refusal (re-confirmed) names the
correct dir and param. No regressions, no source edits, no lasting side effects from the one
self-caught fixture-construction mistake.
