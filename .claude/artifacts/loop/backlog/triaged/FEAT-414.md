---
id: FEAT-414
status: triaged
priority: P2
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: arch-review-2026-07-04
pm_customer_impact: 0.30
pm_effort_estimate: 0.25
pm_strategic_alignment: 0.35
pm_technical_risk: 0.20
pm_dependency_depth: 0.20
pm_effort_points: 3
composite_score: 0.53
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "Architecture review finding 1 [MEDIUM] — mock-provider keyword table vs smoke fixture drift enforced only by doc comments today. No drift incident has occurred yet — preventive test-infra hygiene."
pm_scope_notes: "Smallest deliverable: extract keyword/atom/entity constants into one module imported by both mock-providers.ts and the fixture generator/validator. Byte-compatible sqlite-vec trigger behavior — no test-visible output change."
pm_risks:
  - "Low — pure refactor of test infrastructure, no production code path touched."
reasoning: "Real but low-stakes: prevents a future silent false-negative in the smoke suite, not a current production risk. Pure internal test-hygiene with zero incidents to date."
---
# FEAT-414: Shared constants module for mock-extraction vocabulary ↔ smoke fixture

## Problem
src/pipeline/mock-providers.ts keyword→atom/entity table and tests/smoke/_fixtures/session-canonical.json must stay in lockstep; today only doc comments enforce it. A future keyword edit on one side silently false-negatives smoke assertions.

## Acceptance
- Shared constants module (keyword, atom type, entity) imported by the mock provider and used to generate/validate the fixture — drift becomes a type/test error, not silence.
- Existing sqlite-vec trigger behavior byte-compatible; plugin-flow + smoke suites stay green unchanged.

## Evidence
Architecture review finding 1 [MEDIUM].
