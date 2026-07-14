---
id: FEAT-492
status: pending
priority: null
category: performance
target_release: null
created: 2026-07-14
updated: 2026-07-14
depends_on: []
slices: []
derived_from: memory repo docs/research/2026-07-14-technique-comparison-quality-perf-cost.md
---
# FEAT-492: Content-hash embedding cache (port of cloud's CachingEmbeddingProvider pattern)

## Description

Local calls Ollama (`mxbai-embed-large`) fresh for every embed — identical content re-embedded on
re-index and repeated distill runs. Port cloud's proven pattern
(`CachingEmbeddingProvider.cs`): SHA-256 content-hash cache keyed `(hash, model)` — model in the
key so a model swap can never serve wrong-dimension vectors — with batch-on-miss (check cache
per item, one real call for the miss set). Local flavor: plain SQLite table, no external cache
dependency. Win is latency on the user's machine (Ollama is free — time, not money).

REMEMBER the instruction-prefix trap: mxbai-embed-large is asymmetric (RECALL-S1) — the cache key
must include whether the text was embedded as document or as query, or cache the document side
only.

## Acceptance hints

- Re-running distill/reembed over unchanged content issues zero Ollama embed calls (verified by
  counter).
- Cache keyed by (content hash, model, embed-role); TTL or size cap decided and documented.
- Doctor stat: hit rate visible.

## Notes

Smallest, lowest-risk item from the technique comparison — pattern already proven on cloud.
