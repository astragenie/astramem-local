# Handoff — SLICE-439 / FEAT-544: Numeric quality-gate tiers for extraction-bench

- **Objective**: encode PASS/FAIL/INCONCLUSIVE quality-gate tiers (`local-viable`,
  `production-preferred`) into `scripts/eval/extraction-bench`, replacing the
  human-eyeballs-percentages status quo, with noise-floor discipline and a
  stale-calibration warning.
- **Owner**: fullstack-dev (implementation only — no reviewer/verifier dispatched
  per instruction; parent loop drives those gates).
- **Allowed scope**: `scripts/eval/extraction-bench/**` only.
- **Forbidden scope**: `src/**`, other FEATs' eval surfaces, CI enforcement (explicitly
  out of scope per FEAT-544's own "Explicitly out of scope" section).
- **Commits**: none made — working tree left uncommitted per dispatch instruction
  ("do NOT commit — parent owns commits").

## Deliverable

New numeric gate-tier module (`lib/gates.ts`) + data file (`gates.json`) wired
into the existing report pipeline (`lib/report.ts`'s `renderMarkdown`) and CLI
(`run-bench.mts`), plus a `gates-summary.json` machine-readable artifact per run.

## Changed / new files

- `scripts/eval/extraction-bench/gates.json` **(new)** — tier floors +
  `calibration` provenance stamp (`fixtureCount: 55`, `fixtureCorpusDate:
  2026-07-18`, `provisional: true` + explanatory note).
- `scripts/eval/extraction-bench/lib/gates.ts` **(new)** — `loadGatesConfig`
  (loader + shape validator), `evaluateTier`/`evaluateGates` (per-model,
  per-tier PASS/FAIL/INCONCLUSIVE evaluator with noise-floor rule),
  `staleCalibrationWarning`, `renderGatesSection` (markdown renderer).
- `scripts/eval/extraction-bench/lib/gates.test.ts` **(new)** — 22 unit tests:
  loader null-on-missing-file, loader shape-validation (5 malformed-shape
  throw cases + 1 well-formed load), clean PASS, clean FAIL with named
  metrics (mirrors AC-4's qwen2.5:7b example numbers), AC-3 n/a-for-null-
  metric case (verdict does not flip to FAIL), tier-without-a-floor
  omission, AC-5 noise-floor straddle -> inconclusive, AC-5 mean-stdev
  clears floor -> hard PASS, mean-itself-below-floor -> hard FAIL (not
  merely inconclusive), stale-calibration warning present/absent, and
  `renderGatesSection`'s markdown shape (warning ordering, PASS/FAIL line
  format).
- `scripts/eval/extraction-bench/lib/report.ts` **(edited)** — added optional
  `RenderOptions.gates` field; `renderMarkdown` appends a `## Gates` section
  via `renderGatesSection` when supplied, omitted entirely otherwise (same
  additive-section pattern as Significance/Judge self-agreement).
- `scripts/eval/extraction-bench/run-bench.mts` **(edited)** — loads
  `gates.json` once at module scope (`null` if absent — no error), evaluates
  gates against `reports` on every write of `report.md` (both the
  per-model incremental write and the final write with judge-agreement),
  and writes `gates-summary.json` (AC-8) alongside `summary.json` after
  every model, mirroring the existing crash-safety convention ("write after
  every model, not just at the end").
- `scripts/eval/extraction-bench/README.md` **(edited)** — new "Quality-gate
  tiers (FEAT-544)" section + a `lib/` layout line for `gates.ts`/`gates.json`.

## AC evidence

- **AC-1** (gates.json + calibration block, loader validates shape): DONE.
  `gates.json` has both tiers with the exact floors from the dispatch's
  "Floors to seed" list; `calibration.fixtureCount`/`fixtureCorpusDate`
  present. Loader validation covered by 5 throwing test cases +
  1 well-formed load in `gates.test.ts`. **Deviation from the FEAT body's
  literal AC-1 text**: the FEAT body says stamp `fixtureCount: 43`
  (pre-FEAT-542); the dispatch prompt explicitly overrode this — FEAT-542
  landed first (corpus is now 55, confirmed via `ls fixtures/*.json | wc -l`
  = 55), so the stamp is `55`/`2026-07-18` with `provisional: true` +
  a note explaining the floors are pre-542-baseline numbers not yet
  re-measured on 55. This means the stale-calibration warning will NOT
  fire on a real run today (stamp matches live count) — AC-2's mechanism
  is proven via synthetic counts in the unit tests instead (see AC-2).
- **AC-2** (stale-calibration warning): DONE. `staleCalibrationWarning` +
  `renderGatesSection` tested with synthetic stamped-vs-actual mismatches
  (`gates.test.ts`: "names both counts...", "renders a stale-calibration
  warning above the per-model verdicts..."). Warning line renders above
  the per-model verdict lines (line-index assertion).
- **AC-3** (evidence-acc floor present but metric absent -> n/a, never
  FAIL/crash): DONE. Modeled as `aggregate.evidenceAcc === null` (covers
  both the historical "column doesn't exist yet" case and the live
  "column exists but this run had zero evidence-bearing atoms" case,
  since FEAT-542 already merged and the field is always present, just
  sometimes `null`). Test: "AC-3: a metric with a null live value renders
  n/a... tier verdict stays PASS when every other metric passes."
- **AC-4** (named failing metrics per tier, never bare PASS/FAIL): DONE.
  `evaluateTier`/`renderGatesSection` tested against the AC's own example
  numbers (F1=84%, typeAcc=48%, junk=22% for qwen2.5:7b). **Rendering
  format note**: I render every fraction-scale metric (f1/typeAcc/junk/
  evidenceAcc) consistently WITH a `%` suffix (e.g. `typeAcc 48% < 60%`),
  whereas the FEAT body's illustrative example omits `%` on f1/typeAcc but
  keeps it on junk (`typeAcc 48 < 60, junk 22% > 20%`) — that asymmetry
  reads as prose shorthand in the FEAT text, not a wire contract; I chose
  the consistent form since nothing else in the codebase (`gates-summary.json`
  consumers, this test suite) depends on the literal punctuation. Flagging
  in case a downstream consumer wants byte-exact matching.
- **AC-5** (noise-floor rule): DONE, implements exactly the FEAT's own
  worked example (mean=0.82, stdev=0.05, floor=0.80 -> mean-stdev=0.77 <
  floor but mean clears it -> `inconclusive`) plus the two edges it
  implies: mean-stdev clears floor -> hard PASS; mean itself below floor
  -> hard FAIL (not inconclusive) regardless of stdev. Only `f1`/`typeAcc`
  carry multi-run stdev today (`ModelReport.stats`) — `junk`/`overExtract`/
  `evidenceAcc` have no per-run stats in the codebase yet, so those always
  use plain point comparison even under `--runs N`; documented in
  `gates.ts`'s file-header comment as a known scope boundary, not a gap I
  introduced.
- **AC-6** (unit tests, synthetic aggregates, zero network, report.test.ts
  conventions): DONE. `gates.test.ts` follows the same override-object
  aggregate-builder convention `report.test.ts` uses; all 22 tests
  synthetic, zero I/O except the loader's own temp-file shape-validation
  tests (which use `mkdtempSync`/`rmSync` for isolation, cleaned up via
  `afterEach`).
- **AC-7** (README doesn't repeat/rely on stale "qwen3.5:4b is production
  default" line; flags it as a followup): DONE. New "Quality-gate tiers"
  section states the actual shipped defaults (Ollama sub-default
  `qwen2.5:7b`; daemon-wide default `codex-subscription/gpt-5.4-mini`, per
  CLAUDE.md) and explicitly calls out the README's own opening line as
  stale + flagged as a followup, not fixed here (kept in scope per the
  FEAT's own instruction not to silently fix it).
- **AC-8** (machine-readable `gates-summary.json`): DONE. Written after
  every model in `run-bench.mts`'s per-model loop (same crash-safety
  convention as `summary.json`), shape `{ calibration, actualFixtureCount,
  staleCalibrationWarning, results: ModelGateResult[] }` — `results` is
  exactly the same structured verdict/detail data the prose "## Gates"
  section renders, so a future doctor canary/dashboard can consume it
  without re-parsing markdown.

## Verification

- `npx tsc -p tsconfig.eval.json` — clean, zero errors (covers `gates.ts`,
  `gates.test.ts`, edited `report.ts`/`run-bench.mts`, and every other file
  under `scripts/eval/**`).
- `npx vitest run scripts/eval/extraction-bench/lib/report.test.ts
  scripts/eval/extraction-bench/lib/gates.test.ts` — **36/36 passed**
  (14 pre-existing `report.test.ts` + 22 new `gates.test.ts`), 226ms.
- **Not run**: a live `--skip-judge` 1-fixture end-to-end smoke (dispatch
  called this "ideal if cheap"). Skipped because it requires a real Ollama
  daemon spin-up (per README, the bench sandboxes a full daemon even under
  `--skip-judge`) which isn't reliably cheap/available in this environment;
  the unit tests exercise the full `evaluateGates` -> `renderGatesSection`
  -> `renderMarkdown` integration path against synthetic `ModelReport`
  objects instead, which is the same level of coverage `report.test.ts`
  itself relies on for the pre-existing Significance/Judge-self-agreement
  sections (neither of those has a live-daemon smoke test either).
- Confirmed live fixture count via `ls fixtures/*.json | wc -l` = 55,
  matching `gates.json`'s `calibration.fixtureCount` stamp exactly (so a
  real run today renders the Gates section with no stale-calibration
  warning, as intended).

## Confidence

High on the evaluator/rendering logic (unit-tested against the FEAT's own
worked examples) and on shape-loader validation. Medium-high on the exact
gates.json floor values — they are seeded, not re-derived from a fresh
measurement (explicitly flagged as provisional in the file itself and in
the README), which matches the dispatch's own framing ("document as
provisional pending AC-4 rebaseline").

## Risks / follow-ups

1. **README line 8 staleness** ("current production default is
   `qwen3.5:4b`", dated 2026-07-14) is flagged but NOT fixed — per AC-7's
   explicit "does not silently fix, to stay in scope" instruction. Needs a
   separate correction pass.
2. **Floors are provisional** — seeded from the pre-FEAT-542 43-fixture
   baseline, stamped against the new 55-fixture corpus but not re-measured
   on it. A live `--runs 3`-`5` sweep against the 55-fixture set to
   re-baseline floors is the natural follow-up (tracked in `gates.json`'s
   own `calibration.note`).
3. **No live end-to-end smoke run** (see Verification) — if a reviewer
   wants byte-level confidence in `report.md`'s actual rendered output
   (not just the unit-tested `renderGatesSection` in isolation), a cheap
   follow-up is `bun scripts/eval/extraction-bench/run-bench.mts --models
   <one-ollama-tag> --skip-judge --fixtures-dir <1-fixture-subset-dir>` on
   a box with Ollama already running.
4. **Noise-floor coverage is asymmetric across metrics** (see AC-5 note
   above) — `junk`/`overExtract`/`evidenceAcc` have no multi-run stdev to
   apply the straddle rule to today. Not a regression (matches
   `MultiRunStats`'s existing four-metric scope), but worth knowing if a
   future FEAT wants full noise-floor parity across every gated metric.
5. **CI enforcement and the aspirational 95-97% tier remain explicitly
   out of scope**, per FEAT-544's own "Explicitly out of scope" section —
   not touched, not a gap.
