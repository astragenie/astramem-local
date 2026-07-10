---
id: PM-REVIEW-FEAT-453
feature: FEAT-453
reviewed_at: 2026-07-09
pm_customer_impact: 0.4
pm_effort_estimate: 0.65
pm_strategic_alignment: 0.55
pm_technical_risk: 0.75
pm_dependency_depth: 0.3
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-453

## Demand Assessment

- **Evidence:** Code-verified competitive evidence: docs/research/2026-07-09-competitor-gap-analysis.md, 'Gaps to close (ranked)' #3: 'Graphiti tracks valid_at/invalid_at/expired_at on individual graph edges (facts about entities), which is finer-grained than astramem-local's memory-level as_of... Who does it: graphiti (edges.py:271-282, verified-from-code).' Report explicitly flags this as narrower than a graph engine: 'a narrower ask (temporal fields on the existing entity layer), NOT a new full graph engine.'

## Scope Challenge

- **Scope notes:** Effort 0.65 -> 8 points (FEAT-167 table) -- TRIGGERS the FEAT-168 decomposition gate; proposedSlices sum to 13 points (>= 8). No cost analog for a migration + cross-service slice on file; the FEAT's own ETA (contract+migration design 1d, local migration+distill+query+lifecycle 4-5d, cloud EF migration+query+shipper 3-4d, total 2-2.5 weeks) independently supports the 8-point band. Weak grade dimensions apply as noted on FEAT-451/452. Dependency_depth 0.3 reflects the FEAT's own note: 'Contingent on continued entity-layer investment already being considered' and 'Pairs well with FEAT-456 (contradiction) -- both touch the entity lifecycle; consider sequencing them back-to-back.' This is a soft business-decision contingency, not a hard blocking dependency -- decomposition was still achievable (see proposedSlices), so compositePriority is P2 rather than needs-review; flagging the entity-layer-investment question as an open item for a human sizing pass before slice-1 starts.

## Scores

- customer_impact: 0.40
- effort_estimate: 0.65
- strategic_alignment: 0.55
- technical_risk: 0.75
- dependency_depth: 0.30

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: technical_risk 0.75 sits in the 0.6-0.8 band (schema/data-shape change via migration 022 plus a mirrored EF Core migration on the cloud side -- rollback needs migration cleanup on both systems, not a plain revert, keeping it below the 0.9+ contract-break band since the change is additive/nullable). Narrower and more contingent than FEAT-451/452 (report's own #3 ranking, gated on further entity-layer investment) -- P2, autonomous_safe false given the schema-change band and decomposition requirement.

## Risks

- Pre-mortem (technical_risk >= 0.6, mandatory) 1 -- fails review: migration 022's backfill of valid_at/invalid_at on the existing entities/atoms table interacts badly with concurrent writers during the migration window, or collides with the sqlite-vec schema-derivation pattern CLAUDE.md warns about ('Do NOT hand-edit memories_vec FLOAT[N] in a migration file directly... the dim is single-sourced from DEFAULT_EMBED_DIM') if the migration author isn't careful about which table it touches.
- Pre-mortem 2 -- rollback: this is explicitly a schema/data-shape change (nullable columns added via migration 022) -- git revert alone leaves the DB schema changed; rollback needs a down-migration or manual column drop on the local side, PLUS the mirrored EF Core migration on the cloud side must be coordinated as one event across two independent migration systems, not two independent reverts.
- Pre-mortem 3 -- coverage gap: existing as-of query tests operate at memory-level granularity only; they would not catch a bug where fact-level valid_at filtering silently falls back to memory-level captured_at for atoms that never received a distill-time validity hint -- a silent under-coverage bug, not a crash, that the current test suite has no fixture for.
