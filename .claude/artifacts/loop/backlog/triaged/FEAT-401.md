---
id: FEAT-401
status: pending
priority: null
category: null
target_release: null
created: 2026-07-03
updated: 2026-07-03
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
pm_customer_impact: 0.50
pm_effort_estimate: 0.15
pm_strategic_alignment: 0.65
pm_technical_risk: 0.15
pm_dependency_depth: 0.00
pm_effort_points: 2
composite_score: 0.7175
composite_priority: P1
autonomous_safe: true
pm_demand_evidence: "tests/eval/retrieval-eval.test.ts:76-79 - 'evaluates every query except the known as_of gap (q6)'; report.skipped toBe(1). Concrete, code-tracked capability gap, not a user quote."
pm_scope_notes: "Smallest deliverable: SQL filter on existing valid_from/valid_to + CLI flag, no migration (schema already bitemporal). Cut-if-halved: keep search filter, defer recall CLI flag polish. No overlap with existing FEATs. AC quality: concrete and testable (named eval query, snapshot-identical default). No comparable cost-report slice found under .claude/artifacts/crew/cost/ (directory does not exist yet) - no cost analog, score from dimension table. No grade history exists (.claude/artifacts/loop/grades/ has only grade-template.md) - insufficient data for weak-dimension check, no weak dimensions to target in AC."
pm_risks:
  - "Pre-mortem (P1-mandatory): most likely 2-weeks-later failure cause is the as_of SQL filter interacting incorrectly with the existing supersede/event-log join, silently returning superseded rows outside the requested window."
  - "Rollback: revert-only. No migration touches schema (bitemporal columns already exist); git revert of the filter/CLI diff is sufficient, no state cleanup needed."
  - "Coverage gap: existing tests do not exercise as_of against multi-supersede chains (3+ generations of the same fact) - the AC must add a case with at least two supersede events to close this gap."
reasoning: "Cheap, low-risk, unblocks a named eval gap (q6) with no migration; P1 given operator-flagged low complexity, band 0.0-0.2 technical_risk (known repo pattern, 1-2 files, clean git-revert rollback)."
---
# FEAT-401: `as_of` temporal search (W4.1)

## Description

Point-in-time recall — "what did we believe on date T". Lets a user query memory
as it stood at a past moment, surfacing beliefs later superseded. The store is
already bitemporal (valid_from/valid_to + event log), so this exposes existing
data rather than adding new state.

## Acceptance criteria (Given / When / Then)

**AC-1** Given a memory superseded at time T2 by a newer fact, When search/recall runs with `as_of=T1` (T1 < T2), Then the pre-supersede memory is returned and the post-T2 fact is not.
**AC-2** Given no `as_of` param, When search/recall runs, Then results are byte-identical to current behavior (snapshot test passes unchanged).
**AC-3** Given the ADR-005 eval corpus, When the suite runs, Then previously-skipped q6 executes and passes within the recall@10 ≥ 0.90 / NDCG@10 ≥ 0.70 floors, and `report.skipped == 0`.
**AC-4** Given `--as-of 2026-06-01` on the CLI, When search runs, Then the flag resolves to the same SQL filter as the API `as_of` param (one shared code path — asserted by test).
**AC-5** Given a fact with 3+ supersession generations, When `as_of` targets each generation's validity window, Then exactly the generation valid at that instant is returned (no cross-window leakage into the supersede/event-log join).

## Notes

Roadmap W4.1. Complexity: Low (filter clause + plumbing, no migration). Est 3–5h.
Suggested activation order: 2nd (after W4.5).
