# SLICE-423 (FEAT-457 slice 1) — builder handoff

- **Branch:** `feat/feat-457-multirun-stats`
- **Worktree:** `C:\work\mega\astramemory-local-worktrees\w457s1`
- **Commits:**
  - `10290b5` — "feat(eval): LoCoMo judge multi-run mean±stdev aggregation (FEAT-457 slice 1, AC-4)"
  - `8436f08` — "fix(eval): refuse to combine --run-dir runs sampled with different params (review fix)"
- **Owner:** builder (this run)
- **Status:** implementation complete, review fix round applied, all gates green, no push/merge performed

## Fix round (review finding, MEDIUM-HIGH, resolved in `8436f08`)

Review artifact: `.claude/artifacts/crew/reviews/20260710T162056Z-review-result-slice-423-feat-457-multirun-stats.md`
— verdict `needs_fix`. Finding: `judge.mts`'s multi-run `--run-dir` aggregation
had no guard against combining run dirs sampled with different
`--dataset`/`--seed`/`--n`/`--qa-per-sample` — an operator mixing a smoke-
sized dir with full-`--n` real runs would get a confidently-printed
mean±stdev that's substantively meaningless, the same "silently narrows/
changes scope, looks fully successful" risk class FEAT-462a's resume guard
already closed one stage earlier in the pipeline. Everything else in the
original review (stats correctness, backward compat verified via a live
execution diff, the `stats.ts` promotion, AC-1/2/3/5 citations) was
confirmed correct and not touched in this round.

**Fix, reusing existing infrastructure (not reinventing it):**
- `scripts/eval/shared/run-params.ts` — extracted the pairwise param-diff
  logic that lived inline inside `checkRunParams` into a standalone
  `diffRunParams(a, b)` (pure, no I/O), then had `checkRunParams` call it
  (identical behavior/output format, all its existing tests still pass
  unchanged). Added `evaluateMultiRunParamsGuard(runDirs: string[])` on top
  of the same `diffRunParams`: 0-1 dirs need no comparison and always
  proceed; 2+ dirs must all have a `run-params.json` and agree on every
  field, or the guard returns `{ action: 'refuse', refuseMessage }` naming
  every offending dir and every differing param (or, for a missing file,
  naming the dir with a "predates FEAT-462" message) — no override flag,
  matching DEC-012's refuse-on-mismatch posture.
- `scripts/eval/locomo/judge.mts` — calls `evaluateMultiRunParamsGuard` at
  the top of the multi-run branch, before any `hypotheses.jsonl`/
  `sample.json` is even read; on refuse, prints the message to stderr and
  exits 1.
- `scripts/eval/locomo/judge/metrics.mts`'s `printMultiRunReport` — addressed
  the review's LOW-severity observability nit too: each category line now
  appends `, x/y runs` when the category wasn't present in every combined
  run (e.g. `single-hop: 100% (n=1, 1/2 runs)`), so a partial category isn't
  silently indistinguishable from a fully-covered one. Omitted entirely when
  every run contributed (no change to the common case's line format beyond
  switching `(6)` → `(n=6)` to match the review's own suggested format).
- `scripts/eval/locomo/README.md` — replaced the advisory "repeat the same
  invocation (same flags)" prose with a description of the enforced guard
  and what triggers a refusal.

**New tests** (`scripts/eval/shared/run-params.test.ts`,
`scripts/eval/locomo/judge/metrics.test.ts`): same-params proceeds;
mismatched `--n` refuses naming the dir + param; mismatched seed refuses;
mismatched dataset hash refuses; a dir missing `run-params.json` refuses
with the "predates" message; 3+ dirs flags every offending dir, not just
the first; a single `--run-dir` always proceeds even with no
`run-params.json`; the runs-contributing annotation appears when a category
is partial and is absent when every run contributed; all 113 pre-existing
`scripts/eval/` tests stay green (now 126 total after this round's
additions).

**Gates (fix round, in this worktree):** `bunx tsc --noEmit` clean, `bun run
build` clean, `bunx vitest run scripts/eval/` → 13 files / 126 tests passed
(0 failed). Full `bun run test` flaked on two files unrelated to this slice
(`tests/scripts/post-merge-rebuild.test.ts`, `tests/service/release.test.ts`
— git-fixture-repo/release-materialization tests, zero references to
`scripts/eval/` or `run-params` anywhere) — confirmed both pass cleanly in
isolation (`bunx vitest run` on just those two files: 2 files / 14 tests
passed), and the specific failing sub-test differed between two consecutive
full-suite runs, which is the signature of environment/resource-contention
flake on this shared dev box, not a regression from this change.

## Objective

Implement the one real remaining code change from FEAT-457 (the LoCoMo eval
harness itself already landed on main in commit `480d870` before this slice
started): AC-4 — multi-run mean±stdev aggregation in the LoCoMo judge layer,
reusing extraction-bench's existing `computeStats`/`formatStatsPct` rather
than a bespoke aggregator.

## Changed files

```
scripts/eval/extraction-bench/README.md            |   9 +-
scripts/eval/extraction-bench/lib/judge.ts         |   2 +-
scripts/eval/extraction-bench/lib/report.ts        |   2 +-
scripts/eval/extraction-bench/run-bench.mts        |   2 +-
scripts/eval/locomo/README.md                      |  42 ++++++++-
scripts/eval/locomo/judge.mts                      | 101 ++++++++++++++++-----
scripts/eval/locomo/judge/metrics.mts              |  90 ++++++++++++++++++
scripts/eval/locomo/judge/metrics.test.ts          |  65 ++++++++++++-
scripts/eval/shared/stats.test.ts   (renamed from extraction-bench/lib/stats.test.ts)
scripts/eval/shared/stats.ts        (renamed from extraction-bench/lib/stats.ts)
```

## What changed and why

1. **Promoted `stats.ts`/`stats.test.ts`** from `extraction-bench/lib/` to
   `scripts/eval/shared/` (`git mv`, content otherwise unchanged except the
   file header note). The FEAT explicitly allowed this ("promote to
   `scripts/eval/shared/stats.ts` if cross-tree import is awkward... keep
   extraction-bench importing the same single source"). Updated the three
   extraction-bench import sites (`lib/judge.ts:13`, `lib/report.ts:14`,
   `run-bench.mts:43`) to `../../shared/stats.js` / `../shared/stats.js`, and
   fixed the two README references that pointed at the old path
   (`extraction-bench/README.md`). Cross-tree relative imports between these
   eval subtrees are an existing pattern here (extraction-bench already
   imported `../../longmemeval/lib/...` before this change), so this isn't a
   new kind of coupling.

2. **`scripts/eval/locomo/judge/metrics.mts`** — added `CategoryStats`,
   `MultiRunMetricsReport`, `combineMetricsReports`, `printMultiRunReport`.
   `combineMetricsReports([single])` returns that report **unchanged** (same
   object identity, no `runs`/`category_stats`/`*_stats` keys at all) —
   mirrors `extraction-bench/lib/report.ts`'s `combineRuns` short-circuit
   exactly, which is what makes single-run output backward-compatible.
   `combineMetricsReports([a, b, ...])` computes mean±stdev per category
   (pooling each category's per-run accuracy into `computeStats`), plus
   mean±stdev for `category_averaged_accuracy` and `overall_accuracy`, while
   `n_total` and each category's `n` are **summed** (pooled QA counts) rather
   than averaged.

3. **`scripts/eval/locomo/judge.mts`** — new repeatable `--run-dir <dir>`
   CLI flag (multi-run mode), coexisting with the original `--hyp`/`--ref`
   (single-run, byte-for-byte unchanged code path — I kept it as a separate
   `else` branch rather than threading a flag through the existing logic, to
   make the "unchanged" claim easy to verify by diff). Each `--run-dir` is
   expected to contain the `hypotheses.jsonl` + `sample.json` pair
   `run.mts` always writes into its run dir — no new file format, just
   reading what already exists. `--run-dir` and `--hyp`/`--ref` are mutually
   exclusive (usage error otherwise). `--llm-judge` composes with multi-run
   the same way it does with single-run (both F1 and LLM-judge reports get
   combined independently).

4. **`run.mts` was NOT touched.** Considered adding a `--runs N` flag there
   (mirroring extraction-bench's convention literally), but each `run.mts`
   invocation is a full ingest+distill+answer daemon lifecycle (minutes to
   tens of minutes) — orchestrating N of those inside one process is a much
   bigger, riskier change than AC-4 asked for, and it would have collided
   with FEAT-462 slice A's recent `run-params.json`/`ingest-ledger.jsonl`/
   scope-guard changes in that same file. The chosen shape (repeat
   `run.mts` invocations into distinct `--run-dir`s yourself, then point
   `judge.mts --run-dir` at all of them) is the least-surprising fit given
   how these runs actually repeat in practice, and keeps AC-4 as the only
   real code change as scoped.

5. **`scripts/eval/locomo/README.md`** — new "Multi-run (mean±stdev,
   FEAT-457 slice 1)" section with the exact invocation shape, plus a
   one-line update to the `judge/` layout entry.

## Tests (TDD, deterministic, no network/LLM)

`scripts/eval/locomo/judge/metrics.test.ts` — new `describe('combineMetricsReports — AC-4 multi-run mean±stdev...')` block:
- single-report input returns the same object, no `runs`/`category_stats` keys (backward compat)
- empty-array input throws
- two hand-computed reports (built via the real `computeMetrics`, not hand-typed report objects) verify mean/stdev by hand for: a populated category (n pooled 2+2=4), a second populated category (n pooled 1+1=2), an empty category (stays `NaN`/`null`, not fabricated 0), `category_averaged_accuracy` (mean 0.625, stdev `sqrt(0.03125)`), `overall_accuracy` (identical across runs → stdev exactly 0), and `n_total` summing to 6

No test was added for `judge.mts`'s CLI parsing itself (no existing precedent for a `judge.mts`/`run.mts` unit test — both are top-level orchestrator scripts per the README's own "Tests" section, exercised only by an actual run) — the new `--run-dir` branch reuses `scoreRun`/`combineMetricsReports`/`printMultiRunReport`, all of which are unit-tested.

## AC evidence

- **AC-4 (the real code change): PASS.** `combineMetricsReports`/`printMultiRunReport` in `scripts/eval/locomo/judge/metrics.mts`, wired via `judge.mts`'s new `--run-dir` flag, reusing `scripts/eval/shared/stats.ts`'s `computeStats`/`formatStatsPct` (promoted from `extraction-bench/lib/stats.ts`, no duplicate implementation — extraction-bench now imports the same file). Single-run invocation output is unchanged (verified: `combineMetricsReports([single])` returns the identical object; the CLI's single-run branch is untouched code).
- **AC-1 (shared-tier imports, no duplicate filenames under locomo/): PASS, pre-existing + reinforced.** `scripts/eval/locomo/judge.mts:27-28` imports `azureChatComplete`/`resolveAzureConfig` from `../shared/`; `run.mts:38,42-46` imports `spawn-daemon`/`config`/`shard`/`ollama-tuning`/`resume-ledger`/`run-params` from `../shared/`. `ls scripts/eval/locomo/` shows no shared-tier filename duplicated (only `lib/`, `judge/`, and the orchestrator `.mts` files). This slice's own new import (`judge/metrics.mts` → `../../shared/stats.js`) follows the same rule.
- **AC-2 (`.eval-data` gitignored + CC BY-NC attribution): PASS, pre-existing, unchanged.** `.gitignore:27` (`.eval-data/`); attribution bibtex in `scripts/eval/locomo/README.md` (License section, lines ~24-44 pre-edit).
- **AC-3 (isolated `ASTRA_MEMORY_DATADIR`): PASS, pre-existing, unchanged.** `scripts/eval/shared/spawn-daemon.ts:168` sets `ASTRA_MEMORY_DATADIR: opts.dataDir` per shard's own `datadir` subdirectory; called from `run.mts:124` (`spawnEvalDaemon({ dataDir, token, env: isolated.env })`), never the developer default or prod daemon.
- **AC-5 (six LoCoMo unit suites pure/no-network, vitest.config.ts unscoped): PASS, pre-existing, verified live.** `vitest.config.ts` excludes only `node_modules`/`dist`/`.claude`. `bunx vitest run scripts/eval/` → 13 test files / 113 tests passed (includes all six: `lib/dates.test.ts`, `lib/dataset.test.ts`, `lib/envelope.test.ts`, `judge/porter-stemmer.test.ts`, `judge/metrics.test.ts`, `sample.test.ts`). Full `bun run test` → 204 test files / 2427 passed, 6 skipped, 0 failed.
- **AC-6: explicitly out of scope** (publish-only, requires a human-opened terminal + live `AZURE_OPENAI_API_KEY`, per the FEAT and the harness README's sandbox-reaping incident writeup). Not attempted.

## Gate results (all green, run in this worktree)

- `bunx tsc --noEmit` → clean (no output). Note: neither `tsconfig.json` (`include: ["src/**/*"]`) nor `tsconfig.tests.json` (`include: ["src/**/*", "tests/**/*"]`) actually cover `scripts/eval/`, so this gate doesn't statically check the eval scripts either way — pre-existing project structure, not something this slice changed.
- `bun run build` → clean (`tsc -p .`).
- `bunx vitest run scripts/eval/` → 13 passed (13), 113 tests passed.
- `bun run test` (full suite) → 204 passed (204), 2427 tests passed, 6 skipped, 0 failed.

## Incidental finding (not fixed, out of scope)

While tracking down every `stats.ts` importer, discovered that
`scripts/eval/extraction-bench/lib/judge.ts`, `azure-reasoning-provider.ts`,
`daemon-runner.ts`, and `run-bench.mts` still import from
`../../longmemeval/lib/{azure-client,config,spawn-daemon}.js` / `../longmemeval/lib/config.js`
— but those files no longer exist there (`scripts/eval/longmemeval/lib/`
now only has `dataset.ts`/`dates.ts`/`envelope.ts`/`types.ts`; the daemon-
plumbing tier moved to `scripts/eval/shared/` as part of the FEAT-457
harness landing in `480d870`). This predates this slice (confirmed via
`git diff` — I only touched the `stats.js` import line in each of these
files) and doesn't block anything I touched: `report.ts`'s `judge.js` import
is `import type` only (erased at build/test time), so `report.test.ts` and
the rest of `scripts/eval/` pass regardless. It does mean
`extraction-bench/run-bench.mts` would fail to even parse/run today as a
live script (not exercised by any test). Flagging for a separate,
unscoped-here fix — not part of AC-4 and touching it wasn't requested.

## Confidence / risks

High confidence in the AC-4 implementation and its tests. The main judgment
call was the CLI shape for repeated runs (`--run-dir` on `judge.mts` rather
than a `--runs N` loop on `run.mts`) — documented the reasoning above and in
the README; flag if the team lead wants the alternative shape instead.

## Suggested next handoff

→ `crew:reviewer` for independent review of this diff, then `crew:validator`
if a behavior-level check is wanted (e.g. manually running `judge.mts` with
2+ `--run-dir` fixture directories end-to-end) before slice close.
