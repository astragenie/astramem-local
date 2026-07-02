# ADR-005: Retrieval — contract + shared eval harness, not identical engines

**Status:** accepted · **Date:** 2026-07-02 · **Confidence:** High
**Context:** local runs 4-signal fusion (BM25 .4 / cosine .4 / importance .1 / freshness .1);
cloud runs 6-signal fusion + RRF fallback + cross-encoder seam. Two engines, zero shared
evaluation — today nobody can answer "do both return the right memory?" Strategy Pass 1 3b:
unify by contract, not code.

## Decision

Define `astramem-retrieval@1` as a **contract with three parts**, letting the two engines differ
internally:

1. **Query envelope:** `{ text, mode: keyword|semantic|hybrid, filters: { type[], scope[],
   repo, project, since, as_of }, limit, explain: bool }`. `as_of` (bitemporal time-travel)
   becomes part of the contract — local gains it with atom v3 (ADR-001).
2. **Result contract:** every result carries `ScoreExplanation` — per-signal raw scores +
   weights + final. Explanations are the debugging and trust surface; they are not optional.
3. **Shared golden eval harness (the enforcement mechanism):** a fixture corpus of
   (query → graded-relevant atoms) covering all atom types, temporal cases (superseded vs
   current), entity queries, and cross-session recall. Both implementations run it in CI with
   thresholds (recall@10, NDCG@10). **Divergence between engines is measured and gated, not
   forbidden** — the contract guarantees outcome quality, not formula identity.

**When-to-recall (injection policy) is a separate thin layer, not part of search.** v1:
heuristic client-side policy (task-type gating, confidence threshold, token-budget-aware top-k)
living in the MCP/plugin surface; instrumented by ADR-010 usefulness events so it can become
learned later. This layer — not the store — is the answer to "long context kills retrieval."

**Engine-specific rulings:**
- Cloud: turn the cross-encoder rerank ON (staged rollout, publish NDCG delta) before adding any
  new fusion signal. The seam is paid for; shipping it stub-off is claiming a capability we don't
  exercise.
- Local: no reranker in v1 (CPU budget); adopt matryoshka-style truncated dims when the embedder
  supports it; FTS-only fallback stays (C4 graceful degradation).
- Latency budgets: local p95 < 150 ms warm-cache; cloud p95 < 450 ms (existing DEC-012 budget).

## Options considered

1. **Contract + eval harness (chosen).** Enforceable today, respects C2 (two languages), converts
   the divergence liability into a measured number.
2. **Port cloud's 6-signal engine to TS.** Rejected: weeks of work to copy hand-tuned weights that
   themselves need validation; the eval harness might show the 4-signal engine is fine.
3. **Single shared engine (Rust core, FFI both sides).** Rejected for v1: the rewrite trap
   (C2/C3). Re-evaluate only if the eval harness proves both engines inadequate.

## Consequences & migration

- New artifact: `contracts/` package (JSON Schema for atom + retrieval envelopes + eval fixtures)
  consumed by both repos' CI. This package is the company's technical constitution.
- Sequencing: harness lands right after launch (migration map) — it gates every subsequent
  retrieval change on both sides.
