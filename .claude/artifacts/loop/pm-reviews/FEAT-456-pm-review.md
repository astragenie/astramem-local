---
id: PM-REVIEW-FEAT-456
feature: FEAT-456
reviewed_at: 2026-07-09
pm_customer_impact: 0.45
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.6
pm_technical_risk: 0.6
pm_dependency_depth: 0.3
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-456

## Demand Assessment

- **Evidence:** Competitive evidence: docs/research/2026-07-09-competitor-gap-analysis.md, gap #6: 'mem0 and Zep detect when new info contradicts stored info and auto-resolve. Without this, memory silently accumulates contradictions and recall returns stale facts alongside their corrections.' FEAT body notes it 'directly reinforces FEAT-451 (profile stays consistent) and FEAT-453 (fact-level validity)' -- internal consistency argument, not a user quote.

## Scope Challenge

- **Scope notes:** Effort 0.62 -> 8 points (FEAT-167 table) -- TRIGGERS the FEAT-168 decomposition gate; proposedSlices sum to 10 points (>= 8). No cost analog; the FEAT's own ETA (contract 0.5d, local pairing+judge+guard-rails 4-5d, cloud mirror 3-4d, total ~2 weeks) is comparable in shape to FEAT-453 and independently supports the 8-point band. Weak grade dimensions apply as noted on FEAT-451/452/453. dependency_depth 0.3 reflects the FEAT's own explicit sequencing note: 'Sequence AFTER FEAT-453 if doing both -- shared entity-lifecycle surface' -- a soft coupling, not a hard depends_on (frontmatter depends_on: [] is empty). Risk-radar cascade note: auto-supersede is a state-MUTATION path over stored facts triggered by an automated judge -- not dispatch/halt/retry in the literal sense, but shares the same cascade shape ('touching state-recovery paths can cascade') the Risk Radar calls out; the FEAT's own default-off + restore-is-one-command-away + maxPerRun guard rails are the correct mitigations and should be treated as non-negotiable in any slice, not nice-to-haves.

## Scores

- customer_impact: 0.45
- effort_estimate: 0.62
- strategic_alignment: 0.60
- technical_risk: 0.60
- dependency_depth: 0.30

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: technical_risk 0.6 sits at the entry of the 0.6-0.8 band (cross-module pairing+judge+write-path reach, plus cross-service mirroring; no schema change since it reuses the existing supersede event type, and the design is reversible-by-construction via restore, which keeps it at the low end of the band rather than higher). Reinforces FEAT-451/453 but is itself effort-heavy and touches the same entity-lifecycle surface those slices touch -- P2, autonomous_safe false given the state-mutation cascade risk and decomposition requirement; recommend sequencing after FEAT-453 per the FEAT's own note.

## Risks

- Pre-mortem (technical_risk >= 0.6, mandatory) 1 -- fails review: the local LLM judge misclassifies a 'refines' pair as 'contradicts' and auto-supersedes a still-valid fact; judge accuracy is inherently probabilistic and the maxPerRun guard rail alone does not prevent a systematically-biased judge from being wrong on every run within its cap.
- Pre-mortem 2 -- rollback: revert-only for the CODE path (default off per spec), but facts already auto-superseded before rollback remain superseded in the event log -- data-level rollback requires an operator to manually run restore on the affected atoms; the FEAT's 'one restore away' design is correct but is a manual recovery step, not automatic on code revert.
- Pre-mortem 3 -- coverage gap: no existing test exercises the pair -> judge -> supersede flow end-to-end with a real (non-deterministic) judge; the fake-embedder eval gate stubs the judge for CI determinism, so it structurally cannot catch judge-quality regressions -- that gap needs a dedicated judge-accuracy fixture outside the ADR-005 eval floor, not covered by anything on file today.
