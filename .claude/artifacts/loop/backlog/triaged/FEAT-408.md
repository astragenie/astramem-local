---
id: FEAT-408
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
pm_customer_impact: 0.25
pm_effort_estimate: 0.30
pm_strategic_alignment: 0.50
pm_technical_risk: 0.20
pm_dependency_depth: 0.00
pm_effort_points: 3
composite_score: 0.575
composite_priority: P2
autonomous_safe: false
pm_demand_evidence: "none - prerequisite design work for a not-yet-demanded sync feature (FEAT-407); no stakeholder quote. customer_impact capped <=0.3."
pm_scope_notes: "Smallest deliverable is exactly what the FEAT body scopes: the ADR/design doc itself ('Implementation follows design acceptance (scope TBD after design)') - implementation is explicitly out of scope for this FEAT, which keeps effort_points at 3 (<8, no decomposition gate triggered). AC quality: 'chosen policy + rationale' and 'covers concurrent edit, edit-vs-supersede, edit-vs-erase' are concrete deliverable shapes for a design doc, but the LWW-vs-CRDT choice itself is an architectural judgment call this PM pass should not pre-empt. No grade history / no cost analog available."
pm_risks:
  - "Pre-mortem: most likely failure cause is the ADR choosing a policy that looks correct on paper but doesn't compose with the existing supersede/erase event log semantics already shipped (ADR-010 epsilon-fusion, D-DEF1/D-DEF2), requiring rework once FEAT-407 tries to implement it."
  - "Rollback: revert-only. This FEAT's deliverable is a document; a rejected ADR is simply not adopted, no code or data is touched."
  - "Coverage gap: not applicable in the traditional test sense - the 'test' for this FEAT is architect-reviewer sign-off on the ADR's determinism claim ('deterministic resolution given the same event set on any device'), which has no automated check today."
reasoning: "Design-only deliverable (technical_risk band 0.0-0.2, a document is trivially discarded/revised); autonomous_safe=false because choosing LWW vs CRDT-ish merge semantics is an architectural judgment call requiring human/architect sign-off, not implementation work a builder agent should decide unsupervised. Recommend routing to runner:architect per the PM boundaries section."
---
# FEAT-408: Multi-device conflict policy (W4.8)

## Description

Same memory edited on two devices — decide the merge semantics: last-writer-wins
vs a CRDT-ish event merge. Design-doc-first feature; the policy it produces is a
hard prerequisite for bidirectional pull (FEAT-407).

## Acceptance criteria (Given / When / Then)

**AC-1** Given the ADR, When reviewed, Then it compares LWW vs event-merge (CRDT-ish) with a chosen policy, rationale, and an explicit rejected-alternative note.
**AC-2** Given the chosen policy, When applied to each conflict class — concurrent-edit, edit-vs-supersede, edit-vs-erase — Then each has a single defined deterministic outcome documented.
**AC-3** Given the same event set applied on any device in any receive order, When resolved, Then the final state is identical (convergence property stated and justified).
**AC-4** Given the ADR is accepted, When FEAT-407 planning starts, Then the merge slice shape is derivable from it — i.e. the ADR unblocks 407 (the `depends_on` clears).

Note: this is a design-first FEAT — the deliverable is the ADR (`docs/adr/`), not code. Implementation scope for applying the policy is derived after acceptance (folds into FEAT-407).

## Notes

Roadmap W4.8. Complexity: High — mostly design. Est 8h design + impl TBD.
Blocks FEAT-407. Suggested activation order: 8th (design before sync pull).
