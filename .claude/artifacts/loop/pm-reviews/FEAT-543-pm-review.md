---
id: PM-REVIEW-FEAT-543
feature: FEAT-543
reviewed_at: 2026-07-17
pm_customer_impact: 0.75
pm_effort_estimate: 0.45
pm_strategic_alignment: 0.85
pm_technical_risk: 0.15
pm_dependency_depth: 0.10
composite_priority: P1
autonomous_safe: true
---
# PM Review — FEAT-543 (deep triage)

## Demand Assessment

FEAT-543's own `triage_notes` (frontmatter, as filed 2026-07-17): "issue #190
already showed 334 consolidation-auto corrections with no quality signal on
any of them." FEAT body: "cosine similarity cannot tell 'same fact
paraphrased' from 'two distinct facts about the same subject' (the 0.90-0.92
band documented in consolidate.ts as containing distinct facts, e.g. two
different env-var names at sim 0.91)." Stakeholder: the product's own
consolidation pipeline (`runConsolidation`, `src/consolidate/consolidate.ts`)
which auto-merges >=0.92-similarity pairs today with zero semantic-correctness
check — the 334 unaudited corrections are a live, already-shipped exposure,
not a hypothetical. Current workaround: none — merges are automatic today;
frequency is continuous (every periodic consolidation pass, ADR-004 stage 9).

## Scope Challenge

Smallest deliverable is exactly AC-1/AC-5 as scoped: `tests/eval/consolidation-eval.test.ts`
with >=15 gold fixtures, hand-seeded orthogonal unit vectors (mirrors
`tests/consolidate/proposals.test.ts`'s `vecAt` helper, confirmed present at
lines 171-205 this session), real `runConsolidation`, mechanical outcome-diff.
Overlap check: `tests/consolidate/proposals.test.ts` and `consolidate.test.ts`
cover MECHANICS only (thresholds/pagination/lineage/caps) — zero semantic-quality
assertions exist today; no duplication. AC quality: clear, Given-When-Then-able,
concrete weighted values (5/5/5/4/1) already in the FEAT body — this is the
best-specified of the three FEATs in this batch.

## Risk Radar (pre-mortem — mandatory, compositePriority = P1)

1. **Two weeks later, failed review/validation — most likely cause:** a
   fixture's gold label assumes a similarity value the hand-seeded orthogonal
   unit vectors don't actually produce. Cosine similarity from
   orthogonal-plus-tilt vectors is easy to get subtly wrong by hand, especially
   at the narrow 0.90-0.92 boundary this FEAT specifically targets — a fixture
   could silently test the wrong side of the merge/propose threshold.
2. **This merged and broke the loop — rollback requirement:** plain `git
   revert` only. The eval is read-only against a `:memory:` DB and touches zero
   production consolidation code or schema — no migration, no state cleanup,
   no cross-plugin coordination.
3. **Existing test that would NOT catch a regression:** `tests/consolidate/proposals.test.ts`
   and `consolidate.test.ts` (mechanics-only) would pass even on a merge that
   satisfies every mechanical invariant but destroys distinct information —
   exactly the gap AC-7 (the documented 0.91-band false-merge fixture) closes.

Injection-defense: scanned FEAT-543's body and triage_notes this session — no
embedded imperative found.

## Scores

- customer_impact: 0.75
- effort_estimate: 0.45
- strategic_alignment: 0.85
- technical_risk: 0.15
- dependency_depth: 0.10

## Priority Derivation

composite_priority: P1
autonomous_safe: true
reasoning: pm-scorer.mts formula — P0 requires impact>=0.8, fails (0.75). P1:
(impact>=0.7 AND alignment>=0.6) → 0.75>=0.7 T, 0.85>=0.6 T → **P1**.
autonomousSafe via computeAutonomousSafe: risk 0.15, effort 0.45, dep 0.10 all
<=0.6; hasAcceptanceCriteria=true (8 ACs drafted below) → **true**. Weighted
composite (informational): 0.75×.35 + 0.85×.30 + (1-.45)×.20 + (1-.15)×.10 +
(1-.10)×.05 = 0.7575 — highest of this 3-FEAT batch, matching the architect's
recommended build-first ranking (543 → 542 → 544). effort_points via
pm-effort-mapper.mts (0.4<=x<0.6 → 5): under the FEAT-168 >=8 decomposition
gate, no `proposedSlices` required.

## Apply — frontmatter patch for FEAT-543.md

```yaml
priority: P1
autonomous_safe: true
updated: 2026-07-17
triage_notes: |
  Filed 2026-07-17 after the model-sweep session. Harvested from an external
  eval spec whose methodology was judged strong while its premise (qwen3.5:4b
  as primary candidate, SPO schema rewrite) was rejected as already-refuted /
  anti-H2. This FEAT is the fixture-side harvest only.
  ---
  2026-07-17 PM deep triage: P1, autonomous_safe=true. customer_impact 0.75
  (issue #190: 334 unaudited consolidation-auto corrections, live data-loss
  exposure), effort 0.45 (5 pts), strategic_alignment 0.85, technical_risk
  0.15 (read-only eval, no schema/runtime touch, plain git-revert rollback),
  dependency_depth 0.10 (independent). 8 Given-When-Then ACs drafted inline
  (--deep). Architect-recommended build order: 543 first (this FEAT).
```

## Apply — body section replacement for FEAT-543.md

Replace the existing `## Acceptance criteria` section with:

```markdown
## Acceptance criteria (Given-When-Then)

- AC-1: Given >=15 gold-operation fixtures in `tests/eval/consolidation-eval.test.ts`
  covering all 13 scenario categories (exact duplicate, paraphrased duplicate,
  alias duplicate, newer-status update, explicit correction, compatible
  partial facts, contradictory unresolved facts, hypothesis-later-confirmed,
  multiple-unique-no-merge, same-subject/different-predicate,
  same-predicate/different-object, changed preference, completed-vs-planned),
  When each fixture's stored atoms + incoming candidate(s) are seeded into a
  `:memory:` DB via hand-seeded orthogonal unit vectors written directly
  through `SqliteVecStore.upsert` (mirroring `tests/consolidate/proposals.test.ts`'s
  `vecAt` helper) and the real `runConsolidation` is invoked at production
  thresholds (merge >=0.92, propose 0.85-0.92), Then the actual outcome
  (merged / proposed / untouched / conflict) matches the fixture's
  gold-labeled operation for all 15/15 fixtures.
- AC-2: Given the same 15-fixture set, When `runConsolidation` is exercised
  once with `candidateSelection: 'full'` and once with `candidateSelection:
  'knn'`, Then both modes are asserted against the same gold labels in the
  same test file, and any divergence between the two modes' outcomes on any
  fixture fails the test naming the fixture id and both modes' actual
  outcomes — never silently averaged away.
- AC-3: Given the full fixture run's actual-vs-gold diff, When the weighted
  error report is computed, Then it applies false-merge=5,
  unique-information-deleted=5, meaning-reversal=5, wrong-supersede-direction=4,
  missed-merge=1 per mismatch, prints a total weighted-error score plus a
  per-category breakdown table, and surfaces false-merge count and
  unique-info-loss count as headline numbers in the test output.
- AC-4: Given the current production thresholds (merge 0.92 / propose 0.85),
  When the eval runs, Then the weighted-error total and per-category
  breakdown for this exact threshold pair is written to a run artifact so a
  future threshold-change FEAT has a measured baseline to diff against.
- AC-5: Given `tests/eval/consolidation-eval.test.ts` running under the
  project's standard `vitest run` invocation in CI, When the mechanical
  outcome-diff tier executes, Then zero network calls to any LLM/embed
  provider occur — embeddings are hand-seeded orthogonal unit vectors, not
  `EmbedProvider.embed()` output — and the suite passes deterministically
  with no flake budget for the mechanical tier.
- AC-6: Given the optional LLM-judge merged-text-quality pass, When the test
  suite runs WITHOUT an explicit opt-in environment variable (e.g.
  `CONSOLIDATION_EVAL_JUDGE=1`) set, Then the judge pass is skipped entirely
  (not attempted-and-caught) and the mechanical tier's pass/fail is wholly
  unaffected by judge availability; When the opt-in variable IS set, Then the
  judge pass runs as a separate script or gated block outside the default
  CI-run vitest file, following extraction-bench's Azure-client conventions.
- AC-7: Given the fixture representing two distinct facts about the same
  subject at cosine similarity 0.91 (the exact band `consolidate.ts`
  documents as containing distinct facts, e.g. two different env-var names),
  When `runConsolidation` processes it at production thresholds, Then the
  gold label expects `keep-separate` or `conflict` (NOT merge); if the real
  `runConsolidation` merges them anyway, Then this is recorded as a
  `false_merge` (weight 5) — the single highest-value fixture in the set
  given issue #190's 334 unaudited auto-corrections.
- AC-8: Given a completed eval run, When the weighted-error report is
  generated, Then the eval additionally writes a structured JSON summary to
  the run artifact recording per-category pass/fail counts and the
  false-merge/unique-info-loss headline numbers as machine-readable fields —
  closing the observability gap (weakest of the 7 graded dimensions, avg 0.69
  over the last 5 real slice grades) so a future dashboard or doctor check
  can consume the eval's own quality signal without re-parsing prose.

## Options considered

- Reimplement a simplified merge-decision function for the eval instead of
  calling real `runConsolidation` — rejected: would test the eval's own model
  of consolidation, not production behavior; AC-2 explicitly requires the
  real function.
- House the mechanical tier in `scripts/eval/consolidation-bench/` alongside
  extraction-bench's metered-Azure convention — rejected per the architect's
  2026-07-17 correction: the mechanical tier needs no LLM/Azure spend and
  belongs in-CI vitest like `tests/eval/retrieval-eval.test.ts`, not the
  metered/operator-triggered `scripts/eval/` convention.
```
