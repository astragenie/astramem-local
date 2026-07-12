---
id: FEAT-428
status: done
priority: P2
category: platform
target_release: null
created: 2026-07-05
updated: 2026-07-07
depends_on: [FEAT-426]
slices: []
derived_from: arch-review-FEAT-426-2026-07-05
tags: [concern:ranking, concern:eval, surface:search]
pm_customer_impact: 0.20
pm_effort_estimate: 0.30
pm_strategic_alignment: 0.50
pm_technical_risk: 0.20
pm_dependency_depth: 0.05
pm_effort_points: 3
composite_score: 0.49
composite_priority: P2
autonomous_safe: false
pm_demand_evidence: "none (no end-user demand) — internal arch-review finding only: derived_from arch-review-FEAT-426-2026-07-05, quote from triage_notes: 'no eval evidence that any nonzero weight helps... ADR-005 mandates this discipline for the CLOUD engine... but it was never applied to the local engine.' All three affected weights (eps/zeta/eta) ship default-0 today per FEAT-426 — zero current production exposure."
pm_scope_notes: "depends_on: [FEAT-426] resolved (backlog/done/FEAT-426.md: status: done). This is governance/ADR authorship, not implementation — smallest deliverable is the ADR text plus one CI-enforceable gate (config lint or test asserting no shipped weight>0 without an eval-delta artifact reference). No cost analog."
pm_risks:
  - "The FEAT's own proposed AC ('An ADR... states... A hard gate...') is a policy statement, not a testable Given-When-Then criterion with concrete values — the vague-AC pattern that flags autonomousSafe:false regardless of the mechanical risk/effort/dependency thresholds (which are all individually low here)."
  - "ADR authorship is architect-owned per this repo's role boundaries (crew:architect), not a builder-dispatchable implementation task — runner:architect should draft the ADR extension before this is slice-ready."
reasoning: "P2 via formula (impact 0.20, alignment 0.50 — neither P0/P1 nor P3 conditions fire). technical_risk banded 0.20 (pure docs + a lint/test gate, 1-2 files, trivially revertible). autonomous_safe explicitly overridden to false (mechanical thresholds alone would say true) because the body's proposed ACs are policy prose, not GWT-testable criteria, and the deliverable is architect-owned ADR authorship — flag for runner:architect handoff."
triage_notes: "Arch-review of FEAT-426 (agent soft-boost) findings 1+3. The local retrieval engine now stacks THREE optional additive fusion terms (ε usefulness / ζ entity / η agent) on a base that already sums to 1.0, with no governing document for how many such terms the model tolerates before it needs a learned combiner, and no eval evidence that any nonzero weight helps. ADR-005 mandates this discipline for the CLOUD engine ('turn cross-encoder rerank ON before adding any new fusion signal') but it was never applied to the local engine."
---

# FEAT-428: fusion-model governance — component ceiling + eval-evidence gate before eta>0

## Problem
FEAT-426 added η (agent-match bonus) as the third optional additive term in the
local `fuseScores` model (after ε usefulness / ADR-010 and ζ entity / FEAT-402).
Each active term dilutes every other term's effective share (proven by
`tests/search/fuse.test.ts`). Two governance gaps, both flagged by the FEAT-426
architecture review:

1. **No component ceiling / fitness function.** Nothing states the N at which
   "just add another additive weight per signal" stops being sound and requires a
   learned/weighted combiner. ADR-005 states this discipline for the cloud engine
   only; the local engine has no equivalent.
2. **No eval evidence for any nonzero weight.** `tests/eval/retrieval-eval.test.ts`
   was NOT extended by FEAT-426; there is zero recall@10/NDCG@10 evidence that
   agent-boost (or any eta>0) improves ranking for its intended FEAT-219
   role-scoped-recall use case. All three of ε/ζ/η ship default-0 (inert).

## Acceptance (proposed — re-triage)
- An ADR (extending or superseding ADR-005) states, for the LOCAL engine: max
  tolerated additive fusion components before a learned combiner is required, and
  the rule "no shipped config sets any fusion weight > 0 without a passing
  eval/AB delta."
- A hard gate: any ticket/PR that sets `search.eta` (or ζ/ε weights) > 0 in a
  shipped config MUST include an ADR-005-harness run showing a positive
  recall@10/NDCG@10 delta vs weight=0.

## Refs
- Arch review: `.claude/artifacts/crew/reviews/20260705T*-review-result-feat-426-*` (findings 1, 3).
- ADR-005 retrieval contract; ADR-010 feedback learning loop.
