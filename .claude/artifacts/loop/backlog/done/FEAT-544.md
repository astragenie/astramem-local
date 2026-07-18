---
id: FEAT-544
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-17
updated: 2026-07-18
depends_on: [FEAT-542]
slices: [SLICE-439]
derived_from: "external eval-spec review 2026-07-17 (operator-supplied \"Fable Task\" doc) — §18 quality gates harvested; thresholds recalibrated to measured local reality"
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
started_at: 2026-07-18
slices_complete: [SLICE-439]
completed_at: 2026-07-18
---
## Description

**Numeric quality-gate tiers in extraction-bench report.md.**

Today the bench prints raw numbers and a human eyeballs them; acceptance criteria live in chat transcripts and issue bodies (e.g. #434's phi4-mini gates). Encode tiered gates in the report itself so every run self-classifies:

- **Tier definitions in one config file** (`scripts/eval/extraction-bench/gates.json`): per-metric floors for `local-viable` (e.g. F1 ≥80, typeAcc ≥60, junk ≤20%, over-extract = 0, evidence-acc ≥90 once FEAT-542 lands) and `production-preferred` (F1 ≥88, typeAcc ≥75, junk ≤10%). Numbers seeded from measured 2026-07-17 sweep baselines (qwen2.5:7b 84-90 F1; qwen3.5:9b typeAcc 75-88; judge noise ±7 F1) — documented as revisable, not sacred.
- **Report renders a PASS/FAIL row per model per tier**, with the failing metrics named — a model "passes local-viable except junk 28% > 20%" instead of a wall of percentages.
- **Multi-run aware**: with `--runs N`, a gate only fails if the mean ± stdev interval sits below the floor (respects the FEAT-450 noise-floor discipline; no single-run false verdicts).

## Acceptance criteria (Given-When-Then)

- AC-1: Given `scripts/eval/extraction-bench/gates.json` defining
  `local-viable` (F1>=80, typeAcc>=60, junk<=20%, overExtract=0) and
  `production-preferred` (F1>=88, typeAcc>=75, junk<=10%) tiers, When the
  file is authored, Then it additionally carries a `calibration` block
  stamping the fixture corpus it was calibrated against — `{ "fixtureCount":
  43, "fixtureCorpusDate": "2026-07-17" }` (today's confirmed 43-fixture
  count, pre-FEAT-542) — and the loader validates this block's shape (both
  fields present, `fixtureCount` a positive integer) alongside the tier
  floors.
- AC-2: Given `gates.json`'s stamped `fixtureCount: 43`, When the bench runs
  against a `loadFixtures()` result whose actual fixture count differs from
  the stamped value (e.g. FEAT-542 lands and the directory now holds 53+
  fixtures), Then report.md's Gates section renders an explicit
  stale-calibration warning line (e.g. "gates calibrated against 43
  fixtures; 53 present — floors may not reflect current corpus difficulty")
  above the per-model verdicts, rather than silently applying floors
  calibrated on a smaller/easier corpus.
- AC-3: Given `gates.json` lists an `evidence-acc` floor but the
  currently-loaded report has no "Evidence acc" column (FEAT-542 not yet
  merged), When the gate evaluator runs, Then the `evidence-acc` gate row
  renders `n/a` for every model — never a hard loader error and never a
  false FAIL — and the loader's unit test explicitly covers a `gates.json`
  fixture containing a floor for a metric absent from the report's parsed
  columns.
- AC-4: Given a bench report for model `qwen2.5:7b` with measured F1=84,
  typeAcc=48, junk=22% (2026-07-17 sweep baseline), When the Gates section
  renders, Then it prints a per-tier verdict naming the failing metrics
  concretely — e.g. "qwen2.5:7b — local-viable: FAIL (typeAcc 48 < 60, junk
  22% > 20%); production-preferred: FAIL (F1 84 < 88, typeAcc 48 < 75, junk
  22% > 10%)" — never a bare PASS/FAIL with no metric detail.
- AC-5: Given a `--runs 3` invocation producing mean F1=82 and stdev=5
  against a `local-viable` F1 floor of 80, When the gate evaluator applies
  the noise-floor rule, Then it computes mean-minus-stdev (77) against the
  floor (80): since 77 < 80 but the mean (82) itself clears 80, the verdict
  renders `inconclusive` (straddling), not a hard FAIL; a case where
  mean-minus-stdev clears the floor renders a hard PASS.
- AC-6: Given synthetic aggregate inputs (no live bench run) following
  `report.test.ts`'s existing conventions, When the gate-evaluator unit
  tests run, Then they cover a clean PASS, a clean FAIL with named metrics,
  an `inconclusive` straddle case, and the AC-3 n/a-for-missing-metric case,
  all runnable via the project's standard vitest invocation with zero
  network calls.
- AC-7: Given the bench README currently states "production default is
  qwen3.5:4b" (line 8, dated 2026-07-14, confirmed stale this session
  against CLAUDE.md's "v0180-codex-is-default-provider" record: shipped
  daemon default = codex-subscription/gpt-5.4-mini, Ollama sub-default =
  qwen2.5:7b), When this FEAT's README updates document the gate tiers, Then
  the new documentation does NOT repeat or rely on the stale line — it
  reflects the actual shipped defaults when describing which model the tiers
  gate — and the FEAT's PR flags (does not silently fix, to stay in scope)
  the README line 8 staleness as a followup for separate correction.
- AC-8: Given a completed gate evaluation, When report.md's Gates section is
  rendered, Then the evaluator additionally writes a machine-readable
  `gates-summary.json` (or equivalent field in the run's summary artifact)
  recording each model x tier verdict and named failing metrics as
  structured data, not prose-only — so the observability signal (weakest of
  7 graded dimensions, avg 0.69 over last 5 real grades) survives beyond the
  markdown report for future automated consumption (e.g. a doctor canary or
  dashboard).

## Options considered

- Enforce gates in CI (fail the build on a red gate) — rejected per the
  FEAT's own explicit out-of-scope: bench runs are operator-triggered/metered;
  a red gate must not block merges.
- Adopt the external spec's aspirational 95-97% precision / 99.5% evidence
  tier as a real tier now — rejected: no local model is within reach (best
  measured local F1 84-90, +/-7 judge noise); recorded as rejected-for-now,
  revisit only if a model approaches it.

## Explicitly out of scope

- CI enforcement (bench runs are operator-triggered, metered; a red gate must not block merges).
- The external spec's 95-97% aspirational tier (recorded here as rejected-for-now with rationale; revisit only if a model actually approaches it).
