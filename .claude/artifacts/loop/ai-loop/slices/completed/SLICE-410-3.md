---
id: SLICE-410-3
feature: FEAT-410
status: completed
priority: P2
wave: 1
wave_attempts: 0
pending_fix: false
touches_files:
  - src/search/search.ts
---
# SLICE-410-3: Search debug backend — debug:true fusion intermediates (wave 1, 2 pts)

Design doc: `.claude/artifacts/crew/runs/2026-07-04-dashboard-redesign-design.md` (§6 gap table)
Parent: `.claude/artifacts/loop/backlog/triaged/FEAT-410.md`

## Objective

Add a `debug: true` option to `search()` in `src/search/search.ts` that
returns the intermediate per-candidate fusion components (raw+normalized
bm25, cosine, importance, freshness, fused score + weights) that
search.ts/fuse.ts already compute internally and currently discard before
collapsing to `SearchHit`.

## Scope

Allowed: `src/search/search.ts` + a new unit test file for the debug path.
Forbidden: changing fuse.ts weights or ranking behavior; any route/HTML
work (SLICE-410-6 owns the page); touching queries/dashboard.ts.

Export the debug result type explicitly — it is SLICE-410-6's upstream
contract.

## Acceptance criteria

- AC-1 Given search(query, filters, limit, { ...opts, debug: true }) against
  a query with both FTS and vector hits, Then the result includes
  per-candidate raw+normalized bm25, cosine, importance, freshness, and the
  final fused score/weights — not collapsed to SearchHit.
- AC-2 Given the same query with debug false/omitted, Then output is
  byte-identical to pre-change behavior (existing search tests + ADR-005
  retrieval eval gate must pass untouched).
- AC-3 Given the repo's deterministic fake embedder fixture, When a unit
  test runs the debug path, Then component values are asserted exactly and
  the fused score is reproducible from its documented weights.
- AC-4 Given FTS hits but no vector hits (embed down), When debug mode runs,
  Then vector fields degrade to a documented sentinel (not a throw).
- AC-5 Given an empty query or zero candidates, Then debug mode returns [],
  not an error.

## Done when

All ACs pass with test evidence; `bun run build` green; `vitest run` green
including the ADR-005 eval gate (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7).
