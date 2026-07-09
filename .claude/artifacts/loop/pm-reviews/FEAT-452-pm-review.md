---
id: PM-REVIEW-FEAT-452
feature: FEAT-452
reviewed_at: 2026-07-09
pm_customer_impact: 0.5
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.7
pm_technical_risk: 0.65
pm_dependency_depth: 0.15
composite_priority: P2
autonomous_safe: false
---
# PM Review — FEAT-452

## Demand Assessment

- **Evidence:** Code-verified competitive evidence, not a customer quote: docs/research/2026-07-09-competitor-gap-analysis.md, 'Gaps to close (ranked)' #2: 'Graphiti runs RRF + cross-encoder reranking (bge/openai/gemini) after its initial retrieval; astramem-local's fuse.ts is a weighted-fusion score, not a two-stage retrieve-then-rerank pipeline... Who does it: graphiti (search/search.py:24-65, verified-from-code).' Strategic recommendations #4 repeats: 'Add a cross-encoder rerank stage to the fusion pipeline as a Month-1/2 item.'

## Scope Challenge

- **Scope notes:** Effort 0.62 -> 8 points (FEAT-167 table) -- TRIGGERS the FEAT-168 decomposition gate; proposedSlices sum to 10 points (>= 8). No single cost-report analog for a cross-service, new-local-model-dependency slice; the FEAT's own ETA (contract ~0.5d + local 3-4d + cloud 2-3d, total 1.5-2 weeks) independently supports the 8-point band, so scored from the table using that estimate rather than a cost analog. Weak grade dimensions (see FEAT-447 note): architecture_quality, observability, production_readiness, security, product_completeness are all below 0.80 over the true last-5 grades -- flagged for whichever slice implements the local rerank stage to carry an observability AC (rerank-invoked flag / latency metric) and a production_readiness AC (eval-gate rerank-on-vs-off column, already scoped in the FEAT body). Not drafting full ACs here (P2, no --deep/--spec flag) but recommend the local-stage slice inherit the AC-2/AC-5/AC-6 shape from FEAT-451 above when sliced.

## Scores

- customer_impact: 0.50
- effort_estimate: 0.62
- strategic_alignment: 0.70
- technical_risk: 0.65
- dependency_depth: 0.15

## Priority Derivation

composite_priority: P2
autonomous_safe: false
reasoning: technical_risk 0.65 sits in the 0.6-0.8 band (new external dependency -- a local cross-encoder model runtime -- plus cross-module retrieval-pipeline reach and cross-service coordination; rollback needs a coordinated flag state, not schema migration, keeping it below the 0.9+ band). Strong strategic fit ('single biggest retrieval-quality lever,' half-scaffolded) but large multi-week cross-service effort and nothing broken today -- P2, not inflated to P1 per the batch's own 'do not inflate' guidance; autonomous_safe false given the new dependency + decomposition requirement.

## Risks

- Pre-mortem (technical_risk >= 0.6, mandatory) 1 -- fails review: the local cross-encoder provider (bge-reranker-v2-m3 via Ollama/ONNX) adds unacceptable p99 latency to the retrieval path, or the eval-gate extension shows the rerank stage regresses recall@10/NDCG@10 under the deterministic fake embedder because the mock provider isn't wired correctly.
- Pre-mortem 2 -- rollback: revert-only IF the feature stays fully gated behind config.search.crossEncoder.enabled (default off, already an existing stub per the FEAT body) with no schema change. If the merge lands with enabled flipped default-on in either product, rollback requires a coordinated config/flag change across both local and cloud releases, not a pure git revert.
- Pre-mortem 3 -- coverage gap: the current ADR-005 harness only exercises the single-stage fusion path; it would not catch a rerank stage silently no-op'ing (provider timeout swallowed, falling back to unranked order) since the eval only checks aggregate recall/NDCG, not a per-request 'rerank was actually invoked' assertion -- needs an explicit new test, not covered by anything on file today.
