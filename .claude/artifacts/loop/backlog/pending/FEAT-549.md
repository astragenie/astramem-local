---
id: FEAT-549
status: pending
priority: P2
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: [FEAT-543]
slices: []
derived_from: 2026-07-18 phi-role analysis; scoreboard = FEAT-543's consolidation eval
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
  Filed 2026-07-18. 2026-07-18 phi-role analysis; scoreboard = FEAT-543's
  consolidation eval (confirmed done, tests/eval/consolidation-eval.test.ts
  real per grade SLICE-437).
  ---
  2026-07-18 PM deep triage: P2, autonomous_safe=true. customer_impact 0.60
  (same issue-#190 lineage as FEAT-543, narrower propose-band scope), effort
  0.40 (5 pts, analog SLICE-437 + contradiction-judge.ts pattern reuse),
  strategic_alignment 0.70, technical_risk 0.30 (verbatim reuse of
  contradiction-judge.ts's fail-open/cap shape, no schema change),
  dependency_depth 0.20 (depends_on FEAT-543, CONFIRMED satisfied/done).
  Recommended build order: after FEAT-551/547 (P1s); can run in parallel
  with FEAT-548/546 (no shared surface).
---
## Description

**Consolidation dup-judge — local semantic verdict on the 0.85-0.92 propose band.**

Cosine cannot tell "same fact paraphrased" from "two distinct facts" (documented
0.90-0.92 band). Today those pairs pile up as pending proposals (or get auto-merged
above 0.92 unaudited — issue #190). Add a batched LLM dup-judge over the propose band:

- Verdicts: `same-fact-merge | distinct-keep-separate | unclear-leave-pending`.
- Applied to PROPOSALS only (auto-resolve high-confidence verdicts both directions);
  the >=0.92 auto-merge path is untouched this FEAT (its audit = FEAT-543 eval data).
- Provider configurable, designed for local (phi4-mini class); mirrors
  contradiction-judge's caps + fail-open posture exactly (FEAT-482 lessons: maxPerRun,
  wallclock, never a dollar cap).
- **Scoreboard**: FEAT-543's `tests/eval/consolidation-eval.test.ts` extended with a
  judge-enabled variant — false-merge (weight 5) and missed-merge (weight 1) deltas
  vs the no-judge baseline measured BEFORE any default enablement.

## Explicitly out of scope
- No change to the auto-merge threshold or the contradiction-judge.
- No default enablement (off until the 543-eval shows weighted-error improvement).

## Acceptance criteria (Given-When-Then)

- AC-1: Given pending `ConsolidationProposal` rows with `similarity` in the
  propose band `[proposeThreshold, mergeThreshold)` (default `[0.85, 0.92)`,
  the exact band `consolidate.ts` documents as containing distinct facts at
  its upper edge), When the dup-judge call runs in a batch over those
  proposals, Then it returns one of `same-fact-merge | distinct-keep-separate
  | unclear-leave-pending` per proposal; Given the judge provider throws,
  times out, or returns an unparsable response, Then every proposal in the
  affected batch remains `pending` (today's exact behavior) — fail-open
  mirrors `contradiction-judge.ts`'s posture exactly, proven by a test that
  forces the provider to throw and asserts proposal status is unchanged.
- AC-2: Given `consolidation.dupJudge.mode: 'off'` (the shipped default),
  When consolidation runs, Then no dup-judge call is ever made and pending
  proposals behave byte-identically to pre-FEAT-549; Given `mode: 'dry-run'`,
  When the judge produces a verdict, Then it is logged (structured,
  proposal id + verdict + confidence) but NO proposal status changes; Given
  `mode: 'enabled'`, When a high-confidence `same-fact-merge` or
  `distinct-keep-separate` verdict is produced, Then the proposal is
  auto-resolved accordingly (both directions — `same-fact-merge` executes
  the existing non-destructive merge-as-supersede path, `distinct-keep-
  separate` marks it resolved without merging); Given `unclear-leave-
  pending` or low confidence, Then the proposal is left `pending`
  unchanged.
- AC-3: Given `tests/eval/consolidation-eval.test.ts` (FEAT-543's shipped
  scoreboard), When a judge-enabled variant run is added alongside the
  existing no-judge baseline run, Then it reports the false-merge (weight 5)
  and missed-merge (weight 1) delta between the two runs on the SAME
  15-fixture gold set, and the enablement criterion is documented in the
  test's own output: no false-merge regressions AND net weighted-error
  improvement — this comparison is the hard gate any future `mode: 'enabled'`
  default-flip FEAT must cite, not a one-time measurement that goes stale.
- AC-4: Given a proposal resolved by the dup-judge (either direction), When
  its `metadata_json` is inspected, Then it records resolver provenance
  (`resolved_by: 'dup-judge'`, the verdict, confidence, and model/provider
  used) in the same additive-JSON-column shape `ContradictionMetadata`
  already establishes for the contradiction-judge path — auditable, and
  distinguishable from a human-resolved proposal (`resolve_consolidation_proposal`)
  in the same query.

## Options considered

- Apply the dup-judge to the >=0.92 auto-merge band too (closing issue #190
  fully in one FEAT) — rejected, explicitly out of scope: "the >=0.92
  auto-merge path is untouched this FEAT (its audit = FEAT-543 eval data)";
  auditing that band is a separate, higher-stakes FEAT once FEAT-543's
  measured baseline exists to compare against.
- Reimplement a bespoke prompt/schema for the dup-judge instead of mirroring
  `contradiction-judge.ts` — rejected: the two judges solve structurally
  identical problems (batched pairwise semantic verdict, fail-open, capped)
  and diverging patterns for no reason increases maintenance surface for
  zero benefit.
- Default-enable immediately given FEAT-543's eval already exists — rejected,
  explicitly out of scope: "No default enablement (off until the 543-eval
  shows weighted-error improvement)" — AC-3 produces that evidence, it does
  not substitute for the actual enablement decision.
