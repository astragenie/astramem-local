---
id: FEAT-452
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local, memory]
pm_customer_impact: 0.5
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.7
pm_technical_risk: 0.65
pm_dependency_depth: 0.15
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-09
autonomous_safe: false
triage_notes: "technical_risk 0.65 sits in the 0.6-0.8 band (new external dependency -- a local cross-encoder model runtime -- plus cross-module retrieval-pipeline reach and cross-service coordination; rollback needs a coordinated flag state, not schema migration, keeping it below the 0.9+ band). Strong strategic fit ('single biggest retrieval-quality lever,' half-scaffolded) but large multi-week cross-service effort and nothing broken today -- P2, not inflated to P1 per the batch's own 'do not inflate' guidance; autonomous_safe false given the new dependency + decomposition requirement."
proposed_slices:
  - id_suffix: -SLICE-1
    title: "Contract: additive rerank_score/reranked + rerank request block"
    points: 2
  - id_suffix: -SLICE-2
    title: "Local: cross-encoder provider + post-fusion stage + eval-gate extension"
    points: 5
  - id_suffix: -SLICE-3
    title: "Cloud: rerank call + per-tenant feature flag"
    points: 3
---
## Description

**Two-stage retrieval: cross-encoder reranking on top of fusion.**

Today retrieval is a single-stage weighted fusion score (`src/search/fuse.ts` —
BM25 + vector + importance + freshness + usefulness epsilon). Add an **optional
second stage**: take the top-N fused candidates and re-score them with a
**cross-encoder reranker** (query+passage joint scoring), then return the reranked
order. This is the single biggest retrieval-quality lever and it is already
half-scaffolded — `config.search.crossEncoder { enabled, provider:'mock', topK:50,
timeoutMs:300 }` exists as a stub.

**Why:** Graphiti ships exactly this (RRF → cross-encoder rerank, bge/openai/gemini,
`search/search.py:24-65`, code-verified). Reranking reliably lifts precision@k on
hard queries where lexical+vector fusion alone tie-breaks poorly.

### Local scope (astramem-local, TS)
- Real cross-encoder provider behind the existing config stub: a **local** model
  (bge-reranker-v2-m3 via Ollama or an ONNX runtime) so we keep the no-cloud moat;
  keep `mock` for tests and allow an HTTP provider for BYO.
- New post-fusion stage: fuse → take topK → rerank → merge score into result.
- Extend the ADR-005 eval gate: prove rerank does not regress recall@10/NDCG@10
  under the deterministic fake embedder; add a rerank-on vs -off eval column.
- Expose per-result rerank score in `why_memory` provenance.

### Cloud scope (memory, .NET 10)
- Consume the shared contract field; call a rerank provider (Azure/local) after
  its retrieval stage. Reuse the same topK/timeout semantics.
- Feature-flag per tenant; default off until eval-proven.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Add optional `rerank_score` / `reranked: bool` to the retrieval result type and
  a `rerank` block to the search request. Publish as `contracts-v2.1.0` (additive,
  non-breaking). Both products consume.

### Approximate ETA (1 dev)
- Contract additive change: ~0.5d
- Local: provider + stage + eval-gate wiring: **~3–4d**
- Cloud: rerank call + flag: **~2–3d**
- **Total ≈ 1.5–2 weeks**; local usable end of week 1.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #2). Config stub already present —
lowest-friction of the retrieval features. Unscored; run `/runner:triage`.

## Proposed slices (PM decomposition)

- SLICE-1: Contract: additive rerank_score/reranked + rerank request block (2 pts)
- SLICE-2: Local: cross-encoder provider + post-fusion stage + eval-gate extension (5 pts)
- SLICE-3: Cloud: rerank call + per-tenant feature flag (3 pts)
