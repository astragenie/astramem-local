---
id: FEAT-452
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local, memory]
pm_customer_impact: 0.35
pm_effort_estimate: 0.3
pm_strategic_alignment: 0.6
pm_technical_risk: 0.2
pm_dependency_depth: 0.1
pm_composite_priority: P2
pm_autonomous_safe: true
pm_reviewed: 2026-07-09
autonomous_safe: true
triage_notes: "Effort and technical_risk both collapsed after the architecture-review rewrite confirmed rerank already ships in both repos: remaining scope is an additive field into an already-open, already-schema-anticipated explanation.signals map (contracts/schemas/retrieval-result.v1.schema.json:44-68 literally documents 'including RRF/cross-encoder signals') plus counters/histograms following an established repo pattern (10 existing files) plus a documentation-only product decision -- no new dependency, no cross-service greenfield, 2-3 files, trivially git-revertable, landing technical_risk at 0.20 (low band) vs the prior 0.65. effort_estimate 0.30 -> 3 points (vs prior 0.62 -> 8 points), well clear of the FEAT-168 decomposition gate -- single slice is correct, prior 3-slice/10-point proposed_slices are obsolete and superseded below. compositePriority stays P2 rather than inflating to P1: customer_impact is code-verified but internally-sourced (0.35, below the P1-typical 0.5+ threshold) -- this is explainability/observability polish on a feature that already works today, not a customer-blocking gap, so cheap+safe alone does not earn P1 under this repo's 'do not inflate' posture. autonomousSafe true, contingent on the slice-authoring pass writing GWT ACs that explicitly cover the observability and product_completeness weak dimensions and bound the product-decision item to docs-only scope (detailed in scopeNotes)."
proposed_slices:
  - id_suffix: -SLICE-1
    title: Rerank score field + local observability parity + sidecar-sufficiency decision doc
    points: 3
---
## Description

**Cross-encoder reranking on top of fusion — ALREADY SHIPPED. This FEAT covers the
remaining follow-on work only.**

Cross-encoder rerank is live in both repos today, not a stub to be built:
- Local: `src/search/rerank.ts` (`MockCrossEncoderProvider` + `HttpCrossEncoderProvider`,
  TEI-compatible, issue #26, PRs #94/#103), wired post-fusion at
  `src/search/search.ts:497-522`, eval-gated in
  `tests/eval/retrieval-eval.test.ts:172-208`, with a runbook at
  `docs/runbooks/cross-encoder-rerank.md`.
- Cloud: FEAT-268/SLICE-189, completed 2026-07-04 — `HttpCrossEncoderRanker` with
  full metrics.

**Why (remaining work):** the shipped implementation has three known gaps worth
closing:

1. **No separate rerank score field.** `applyRerank` overwrites `hit.score` in
   place (src/search/rerank.ts:272-282) — there is no distinct `rerank_score` /
   `reranked` field, so `why_memory` has zero rerank awareness and callers can't
   tell a fused score from a reranked one. Likely additive via
   `contracts/schemas/retrieval-result.v1.schema.json`'s open
   `explanation.signals` map (no major version bump needed).
2. **No local observability parity with cloud.** Cloud has outcome-tagged
   counters/histograms for its reranker; local rerank emits none.
3. **Open product decision:** does the shipped `HttpCrossEncoderProvider` talking
   to a `127.0.0.1` sidecar already satisfy the "local-only, no-cloud-moat" goal,
   or is an embedded local model (e.g. bge-reranker-v2-m3 via Ollama/ONNX) actually
   required? Decide before scoping any provider work.

### Local scope (astramem-local, TS)
- Add `rerank_score` (and/or a `reranked: bool` flag) as a field distinct from the
  existing fused `hit.score`, threaded through to `why_memory` provenance.
- Add outcome-tagged counters/histograms for rerank invocations, matching the
  cloud pattern.
- Resolve the embedded-model-vs-sidecar product question above; only scope new
  provider work if the sidecar is judged insufficient.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Add optional `rerank_score` / `reranked: bool` to the retrieval result type via
  the existing `explanation.signals` open map in
  `retrieval-result.v1.schema.json` — additive, no major bump expected.

### Approximate ETA (1 dev)
- Remaining scope is roughly **1 slice** (score field + observability +
  product-decision spike), not the original 3-slice/2-week estimate — that
  estimate assumed rerank didn't exist yet. This FEAT needs PM re-triage with a
  substantially lower effort/risk score before slicing.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #2). Originally intaken as if rerank
were unbuilt; architecture review found it already shipped in both repos — see
corrections section. Needs PM re-triage.

## Proposed slices (PM decomposition — STALE, see corrections)

The 3-slice breakdown below assumed rerank was unbuilt and no longer reflects
actual remaining scope (see Architecture review corrections). Retained here
pending PM re-triage; do not dispatch against it as-is.

- SLICE-1: Contract: additive rerank_score/reranked + rerank request block (2 pts)
- SLICE-2: Local: cross-encoder provider + post-fusion stage + eval-gate extension (5 pts)
- SLICE-3: Cloud: rerank call + per-tenant feature flag (3 pts)

## Architecture review corrections (2026-07-09)

**Premise was stale.** Cross-encoder rerank is already shipped, not proposed work:
- Local: `src/search/rerank.ts` (MockCrossEncoderProvider + HttpCrossEncoderProvider,
  TEI-compatible, issue #26, PRs #94/#103), wired post-fusion at
  `src/search/search.ts:497-522`, eval-gated at
  `tests/eval/retrieval-eval.test.ts:172-208`, runbook at
  `docs/runbooks/cross-encoder-rerank.md`.
- Cloud: FEAT-268/SLICE-189 completed 2026-07-04 (HttpCrossEncoderRanker + full
  metrics).

Rescoped to remaining work only:
1. Expose `rerank_score`/`reranked` as fields distinct from the in-place-overwritten
   `hit.score` (src/search/rerank.ts:272-282); wire into `why_memory`.
2. Local observability parity with cloud's outcome-tagged counters/histograms
   (local rerank currently has none).
3. Product decision: is an embedded local model actually needed, or does the
   already-shipped HTTP sidecar at 127.0.0.1 already satisfy the local-only
   requirement?

The 3-slice/2-week framing is dropped — remaining scope is ≈ 1 slice. This FEAT
needs PM re-triage with lower effort/risk before it is dispatched; the
`pm_effort_estimate: 0.62` / `pm_technical_risk: 0.65` / proposed_slices in this
file's frontmatter are stale and were left untouched per editing constraints —
re-triage should supersede them.
