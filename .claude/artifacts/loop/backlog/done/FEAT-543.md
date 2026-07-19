---
id: FEAT-543
status: done
priority: P1
category: feature
target_release: null
created: 2026-07-17
updated: 2026-07-18
depends_on: []
slices: [SLICE-437]
derived_from: "external eval-spec review 2026-07-17 (operator-supplied \"Fable Task\" doc) — §13-15 harvested; terminology mapped from its \"compaction\" to this repo's CONSOLIDATION"
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
started_at: 2026-07-18
slices_complete: [SLICE-437]
completed_at: 2026-07-18
---
## Description

**Consolidation semantic-quality eval — gold-operation fixtures + weighted error scoring.**

`runConsolidation` auto-merges ≥0.92-similarity pairs and proposes 0.85-0.92 ones. Every existing test checks the MECHANICS (thresholds, pagination, lineage, caps) — none checks whether a merge was semantically RIGHT. Known live risk: cosine similarity cannot tell "same fact paraphrased" from "two distinct facts about the same subject" (the 0.90-0.92 band documented in consolidate.ts as containing distinct facts, e.g. two different env-var names at sim 0.91).

Build a small gold-operation eval:

1. **Fixture set** (~15 scenarios, JSON, version-controlled): exact duplicate, paraphrased duplicate, alias duplicate, newer-status update, explicit correction, compatible partial facts, contradictory unresolved facts, hypothesis-later-confirmed, multiple unique facts that must NOT merge, same subject/different predicate, same predicate/different object, changed preference, completed-vs-planned work. Each fixture: a set of stored atoms + one-or-more incoming candidates + the GOLD operation (merge / supersede / keep-separate / conflict).
2. **Runner**: seed atoms into `:memory:` DB with controlled embeddings (reuse the proposals.test.ts vector-seeding pattern), run real `runConsolidation`, diff actual outcomes (merged/proposed/untouched) against gold.
3. **Weighted error score** (heavier penalty for destructive mistakes): false merge = 5, unique-information deleted = 5, meaning reversal = 5, wrong supersede direction = 4, missed merge = 1. Report one weighted total + per-category breakdown.
4. **Judge-optional**: mechanical outcome-diff needs no LLM; an optional LLM-judge pass can grade merged-text quality (information preserved?) behind a flag, following extraction-bench judge conventions.

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

## Explicitly out of scope

- Changing thresholds or consolidation behavior (this FEAT only MEASURES; a threshold change would be its own gated FEAT citing these numbers).
- The contradiction-judge LLM path (already capped/governed — FEAT-482 incident; do not add LLM calls to the default eval tier).
