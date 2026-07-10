---
id: PM-REVIEW-FEAT-451
feature: FEAT-451
reviewed_at: 2026-07-09
pm_customer_impact: 0.55
pm_effort_estimate: 0.48
pm_strategic_alignment: 0.75
pm_technical_risk: 0.35
pm_dependency_depth: 0.15
composite_priority: P1
autonomous_safe: true
---
# PM Review — FEAT-451

## Demand Assessment

- **Evidence:** Competitive/market evidence (not first-party customer quote -- scored accordingly, not inflated to 1.0): docs/research/2026-07-09-competitor-gap-analysis.md, 'Gaps to close (ranked)' #1: 'Persistent user-profile object. Confirmed twice now -- once via Supermemory's static facts + dynamic context claim (2026-07-08 supermemory-matrix.md) and again via memobase's explicit profile+event-timeline model in this pass.' Strategic recommendations #2 repeats it: 'Ship the persistent user-profile object next. It's the most-repeated gap across two independent research passes.'

## Scope Challenge

- **Scope notes:** Effort 0.48 -> 5 points (FEAT-167 table), below the 8-point decomposition gate -- single-wave slice is fine. Cost analog: FEAT-441 SLICE-419 durability-gate work is the closest shape on file (aggregate $221.74 across repos / ~$41.09 astramemory-local-only portion, medium-classified, cross-module distill-pipeline change -- .claude/artifacts/crew/cost/20260709T110619Z-cost-report-aggregate-feat441-slice419.md) -- FEAT-451 adds a new API route + MCP tool on top of similar aggregation-over-existing-output scope, so scored slightly above that analog at 5 points rather than confirmed-equal. SCOPE MISMATCH FLAGGED: the operator's batch framing classified FEAT-451 as cross-product (astramem-local + memory SaaS), but unlike FEAT-452/453/454/456 the FEAT-451 body has NO 'Cloud scope' / 'Shared contract impact' section and no cross_product frontmatter tag -- it is written and scored here as astramemory-local-local-only, per the source-of-truth FEAT body, not the batch summary. Recommend the intake author add cross_product frontmatter + a cloud section if SaaS parity is intended, or explicitly confirm local-only before slicing. Weak grade dimensions (true last-5 average, see FEAT-447 note): architecture_quality 0.51, observability 0.654, production_readiness 0.504, security 0.51, product_completeness 0.504 -- all below 0.80. Because compositePriority is P1, ACs below are drafted inline per FEAT-277 and deliberately target every one of these five weak dimensions (AC-2 architecture_quality/single-module reuse, AC-3 product_completeness/lifecycle correctness, AC-4 security/scope isolation, AC-5 observability/structured logging, AC-6 production_readiness/CI-eval determinism) plus the happy path (AC-1).

## Scores

- customer_impact: 0.55
- effort_estimate: 0.48
- strategic_alignment: 0.75
- technical_risk: 0.35
- dependency_depth: 0.15

## Priority Derivation

composite_priority: P1
autonomous_safe: true
reasoning: technical_risk 0.35 sits in the 0.3-0.5 band (new aggregation pattern layered over existing typed-distillation output and the existing event stream, no schema/contract change per the FEAT's own scope, clean rollback if kept table-free). Highest-ranked, most-repeated competitive gap with moderate (not epic) effort and strong strategic fit to the product's core memory-quality mission -- P1, not inflated to P0 since nothing is broken today and the gap is strategic rather than urgent.

## Risks

- Pre-mortem (P1, mandatory) 1 -- fails review/validation: the profile-rebuild logic duplicates aggregation/query logic instead of reusing the existing typed-distillation atom store and event stream, creating a second source of truth that drifts from why_memory provenance -- exactly the architecture_quality weak dimension the last 5 grades already flag.
- Pre-mortem 2 -- rollback if this merges and breaks the loop: revert-only IF scoped as a new endpoint + new aggregation module with no persisted materialized-view table (as the FEAT body specifies, 'no new storage primitive'); if the build instead adds a profile table/materialized view to hit a performance target, rollback requires a migration/data cleanup, not a plain git revert -- the build dispatch must state 'no schema change' up front, mirroring the DEC-419-1 lesson from FEAT-441 SLICE-419 where an unscoped table was caught only at human review.
- Pre-mortem 3 -- coverage gap: the ADR-005 recall@10/NDCG@10 eval gate would NOT catch a privacy leak (GET /profile returning another scope's data) or a stale-profile-after-invalidate bug, since it only measures retrieval quality -- AC-3 (lifecycle) and AC-4 (scope isolation) are the tests that must exist to close this gap; without them a regression here ships silently green.
