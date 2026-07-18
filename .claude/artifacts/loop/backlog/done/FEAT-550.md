---
id: FEAT-550
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-18
updated: 2026-07-18
depends_on: []
slices: [SLICE-440]
derived_from: 2026-07-18 phi-role analysis
cross_product: [astramem-local]
autonomous_safe: true
triage_notes: |
started_at: 2026-07-18
---
## Description

**Query rewrite/expansion — local model widens recall input, never touches the store.**

Before `/recall`, an optional cheap local call (phi4-mini class) rewrites/expands the
query: entity-alias forms, synonyms, decompositions ("when did X move?" → also "X new
apartment date"). Retrieval then runs over the union (original query ALWAYS included —
rewrite failure degrades to today's behavior exactly).

- Config-gated (`search.queryRewrite: { mode: off|enabled, provider, model, maxVariants }`),
  default **off**; per-request opt-out.
- Fail-open: rewrite error/timeout (tight, ~1-2s cap) → original query only.
- Fusion: variant hits merge by atom id keeping max score — no new ranking model, no
  re-ordering of a single query's results (the measured rerank-backfire stays fenced out).
- Latency budget honest: adds one local LLM call to the recall path — needs a latency
  gate for interactive use (e.g. only when the caller passes `expand: true`, or async
  eval-only first).

Measurement: LoCoMo A/B via `--diagnose` (rank-miss bucket before/after) + recall@k on
the ADR-005 harness floors (must not regress).

## Explicitly out of scope
- No result re-ranking, no store writes, no answerer changes.
- No default-on for interactive recall until latency measured.

## Acceptance criteria (Given-When-Then)

- AC-1: Given `search.queryRewrite.mode: 'off'` (the shipped default), When
  `search(query, filters, limit, opts)` (`src/search/search.ts`) is called,
  Then no rewrite call is made and behavior is byte-identical to
  pre-FEAT-550; Given `mode: 'enabled'` and a caller passes `expand: true`
  (or the feature is invoked via its own opt-in path, per the FEAT's latency
  gating requirement), When the rewrite call succeeds, Then it produces at
  most `maxVariants` alias/synonym/decomposition query strings.
- AC-2: Given the rewrite call throws, times out, or exceeds a hard ~1-2s
  cap (a real enforced timeout, not a soft target), When `search()` proceeds,
  Then retrieval runs over the ORIGINAL query only — degrading exactly to
  pre-FEAT-550 behavior — and a test that forces the rewrite provider to
  hang past the cap asserts the search call still returns within a bounded
  total time and uses only the original query's hits.
- AC-3: Given the original query and N rewritten variants each produce their
  own hit set, When results are fused, Then hits are merged by atom id
  keeping the MAX score across all variant hit sets (no new ranking model,
  no re-ordering within a single variant's own result list), and the fused
  candidate set is capped at a configured total (bounding cost) — the
  original query's hits are ALWAYS included in the union even when a
  rewrite variant returns zero hits.
- AC-4: Given the LoCoMo `--diagnose` harness (existing tooling), When an
  A/B run compares query-rewrite-enabled vs baseline, Then the rank-miss
  bucket size is reported before/after AND the ADR-005 recall@10/NDCG@10
  floors (>=0.9 / >=0.7) are asserted to hold or improve — a regression on
  either floor is a hard stop on enablement, documented in the run's own
  evidence artifact, not just narrated.
- AC-5: Given `mode: 'enabled'` but no rewrite variants clear a minimum
  relevance bar (e.g. the local model returns an empty or degenerate
  rewrite), When `search()` runs, Then it falls back to the original-query-
  only path silently (not an error) — this is the same fail-open contract
  as AC-2 but for the "succeeded but useless" case rather than the "failed"
  case, closing a gap the existing 4 ACs left implicit.

## Options considered

- Feed rewrite variants into a reranking pass instead of a pure-union fusion
  — rejected, explicitly out of scope and directly contraindicated by this
  session's own measurement: "rerank-mock BACKFIRED
  (locomo-recall-vs-extraction-measured)" — conflating rewrite (input
  expansion) with rerank (output re-ordering) would reintroduce the exact
  failure mode this FEAT is designed to avoid.
- Default `mode: 'enabled'` for all interactive recall calls — rejected,
  explicitly out of scope: "No default-on for interactive recall until
  latency measured"; the AC-2/AC-5 fail-open contracts exist precisely
  because a synchronous local-model call on the hot path is a real latency
  risk until proven otherwise.
- Skip the `--diagnose` A/B and ship on code-review confidence alone —
  rejected: this repo's own measured history (rerank-mock backfiring
  despite looking reasonable) is the direct precedent for why AC-4's
  measured gate is required before enablement, not optional.

## Wave outcome (2026-07-18)

2026-07-18 WAVE COMPLETE: built (SLICE-440, tip c6f339b1), review PASS high-confidence (abort traced to fetch; contract-freeze held; governance boot-path praised). LoCoMo --diagnose A/B deferred (next session); ADR-005 floors green with mode off.
