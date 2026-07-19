---
id: PM-REVIEW-FEAT-544
feature: FEAT-544
reviewed_at: 2026-07-17
pm_customer_impact: 0.40
pm_effort_estimate: 0.38
pm_strategic_alignment: 0.60
pm_technical_risk: 0.15
pm_dependency_depth: 0.30
composite_priority: P2
autonomous_safe: true
---
# PM Review — FEAT-544 (deep triage)

## Demand Assessment

FEAT body: "acceptance criteria live in chat transcripts and issue bodies
(e.g. #434's phi4-mini gates)" — a real, if low-severity, process gap
(informal tribal-knowledge gates). Triage_notes: the external spec's
95-97%/99.5% gates are explicitly rejected as unrealistic for local models,
with this FEAT shipping honest tiers "derived from measured baselines, not
aspirational ones." Stakeholder: whoever reads report.md to decide if a model
is "good enough" to ship (today: a human eyeballing raw percentages). Current
workaround: tolerable but informal — works today, not durable or
self-documenting across runs, capping customer_impact at 0.4.

## Scope Challenge

Smallest deliverable: `gates.json` + loader/evaluator + report Gates section
+ unit tests, exactly per the FEAT's 5 ACs, extended per architect-reviewer
follow-up (2026-07-17) with a fixture-corpus provenance stamp and a
stale-calibration warning (AC-1/AC-2 below). Dependency note:
`depends_on: [FEAT-542]` is explicitly SOFTENED in the FEAT body — the
evidence-acc floor renders `n/a` until 542 lands; every other gate ships
independently. `dependency_depth` scored 0.3 (not near-zero) to reflect that
one gate row is genuinely inert pending FEAT-542, without treating the whole
FEAT as blocked.

**Correctness note verified this session:** `scripts/eval/extraction-bench/README.md`
line 8 states "production default is `qwen3.5:4b` (2026-07-14...)" — this is
STALE. Per CLAUDE.md's own "v0180-codex-is-default-provider" record, the
shipped daemon default since 2026-07-14 is `codex-subscription`/`gpt-5.4-mini`,
with `qwen2.5:7b` as the Ollama sub-default (v0.19). AC-7 requires this
FEAT's README updates not repeat or rely on the stale line, and to flag (not
silently fix) line 8 as a followup for separate correction.

## Risk Radar

Not mandatory (technical_risk 0.15, priority P2) but recorded:

- Once FEAT-542 lands (53+ fixtures, harder categories), a model that passed
  `local-viable` on the old 43-fixture corpus could silently fail on the new
  one with stale floors still claiming a PASS — exactly the hazard AC-1/AC-2
  (provenance stamp + stale-calibration warning) close.
- Without AC-2's warning, a green Gates section post-FEAT-542 could be
  wrongly read as "still clears the bar under the harder mix" — the
  silently-wrong-looking-green class ADR-015 exists to prevent.

Injection-defense: scanned FEAT-544's body and triage_notes this session — no
embedded imperative found.

## Scores

- customer_impact: 0.40
- effort_estimate: 0.38
- strategic_alignment: 0.60
- technical_risk: 0.15
- dependency_depth: 0.30

## Priority Derivation

composite_priority: P2
autonomous_safe: true
reasoning: pm-scorer.mts — P0 fails (impact 0.4). P1: (impact>=0.7 AND
alignment>=0.6) fails (impact); (alignment>=0.8 AND effort<=0.4) fails
(alignment 0.6 < 0.8). P3: effort>=0.7 fails (0.38). → **P2** — ties with
FEAT-542 at the same composite tier under the deterministic formula. Weighted
composite (informational): 0.4×.35 + 0.6×.30 + (1-.38)×.20 + (1-.15)×.10 +
(1-.3)×.05 = 0.564 — lowest of the 3-FEAT batch (543: 0.7575, 542: 0.615, 544:
0.564), the basis for recommending the architect's stated build order (543 →
542 → 544) as the actual dispatch sequence even though 542/544 tie at P2.
autonomousSafe: risk 0.15, effort 0.38, dep 0.30 all <=0.6; hasAcceptanceCriteria=true
(8 ACs drafted below) → **true**. effort_points via pm-effort-mapper.mts
(0.25<=x<0.4 → 3): smallest of this batch, well under the decomposition gate.

## Apply — frontmatter patch for FEAT-544.md

```yaml
priority: P2
autonomous_safe: true
updated: 2026-07-17
triage_notes: |
  Filed 2026-07-17. The external spec's gates (precision ≥95-97%, evidence
  ≥99.5%) are unrealistic for local models (best measured local F1 = 84-90
  with ±7 judge noise; even codex fails its recall gate) — but the IDEA of
  tiered numeric gates in the report is right. This FEAT ships the mechanism
  with honest tiers derived from measured baselines, not aspirational ones.
  ---
  2026-07-17 PM deep triage: P2, autonomous_safe=true. customer_impact 0.40
  (informal-but-tolerable eyeballing workaround), effort 0.38 (3 pts,
  smallest of the 3-FEAT batch), strategic_alignment 0.60, technical_risk
  0.15 (config + report rendering, known repo pattern), dependency_depth
  0.30 (evidence-acc floor inert pending FEAT-542, all other gates ship
  independently per the FEAT's own softened dependency). Added per
  architect-reviewer follow-up: gates.json calibration-provenance stamp +
  stale-calibration warning (AC-1/AC-2); flagged bench README line 8's stale
  "production default is qwen3.5:4b" claim (AC-7) — do not repeat it. 8
  Given-When-Then ACs drafted inline (--deep).
```

## Apply — body section replacement for FEAT-544.md

Replace the existing `## Acceptance criteria` section with:

```markdown
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
```
