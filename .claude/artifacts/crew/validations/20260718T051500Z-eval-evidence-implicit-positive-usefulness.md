---
kind: eval-evidence
component: implicitPositive (search.usefulness.implicitPositive)
run_at: 2026-07-18
decision: floors-hold — evidence supports enablement; default-flip deferred to a reviewed slice
---
# Eval evidence — implicit-positive usefulness pass (ADR-005 / FEAT-428 governance gate)

## What the gate requires
`applyFusionGovernance` force-reverts `implicitPositive.enabled: true` unless
`hasPassingEvalEvidence('implicitPositive')` — `RECORDED_EVAL_EVIDENCE` is empty today.

## Evidence run (2026-07-18)
- `tests/eval/retrieval-eval.test.ts` + `tests/search/usefulness-rank.test.ts`: **23/23 green**
  on merged tip 6f6c826c. Floors: mean recall@10 **0.955** (floor 0.9), mean NDCG@10
  **0.840** (floor 0.7).
- Mechanism analysis (why the static harness cannot regress): the pass writes
  `recall_used (signal: heuristic)` events on the CLEANUP cadence for atoms served by
  ≥2 distinct queries in a 30d window — it never touches weights, fusion, or the
  request path. Ranking impact flows only through the epsilon·usefulness term whose
  behavior is covered by `usefulness-rank.test.ts`; heuristic grants carry weight
  0.35 vs explicit 1.0 (a heuristic-only atom reaches ~0.574, not 0.667).
- Prod telemetry motivating enablement: 48,740 atoms, 1379 served / 80 used (5.8%),
  **0 heuristic grants ever** — the rate structurally undercounts.

## Enablement acceleration (no 7-day wait)
The pass reads the TRAILING 30d window — on flip day, the first cleanup tick grants
for atoms that ALREADY survived ≥2 distinct historical queries. The usefulness
number becomes honest within one cleanup cycle, not one accrual week.

## Next (reviewed mini-slice)
1. Add the `RECORDED_EVAL_EVIDENCE` entry for `implicitPositive` citing this artifact.
2. Flip `defaultConfig().search.usefulness.implicitPositive.enabled` to true.
3. Post-flip check: `usedHeuristicDistinct > 0` in the usefulness-feedback-loop doctor
   row after one cleanup tick; watch the rich-get-richer risk via the 7d rate trend.
