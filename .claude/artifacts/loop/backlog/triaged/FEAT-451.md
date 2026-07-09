---
id: FEAT-451
status: triaged
priority: P1
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
pm_customer_impact: 0.55
pm_effort_estimate: 0.48
pm_strategic_alignment: 0.75
pm_technical_risk: 0.35
pm_dependency_depth: 0.15
pm_composite_priority: P1
pm_autonomous_safe: true
pm_reviewed: 2026-07-09
autonomous_safe: true
triage_notes: "technical_risk 0.35 sits in the 0.3-0.5 band (new aggregation pattern layered over existing typed-distillation output and the existing event stream, no schema/contract change per the FEAT's own scope, clean rollback if kept table-free). Highest-ranked, most-repeated competitive gap with moderate (not epic) effort and strong strategic fit to the product's core memory-quality mission -- P1, not inflated to P0 since nothing is broken today and the gap is strategic rather than urgent."
---
## Description

Add a **persistent, incrementally-updated user-profile object** — a standing,
queryable summary of who the user/agent is (stable facts, preferences, recurring
context) that updates as new memories are distilled, distinct from the
per-request `/recall/pack` and per-session `session_digest`.

**Why:** #1 ranked competitive gap (docs/research/2026-07-09-competitor-gap-analysis.md).
Confirmed twice — Supermemory markets a "static facts + dynamic context" profile,
and memobase implements an explicit profile + event-timeline model. astramem-local
has recall-pack (per-query, ephemeral) and session_digest (per-session) but NO
standing profile that persists and accretes across sessions. This is the single
most-cited thing competitors surface that we lack, and it maps directly onto our
strengths (typed distillation + event log).

**Scope / approach (Effort: M):** aggregation logic over EXISTING typed-distillation
output — no new storage primitive. Roll up high-confidence, durable, entity-typed
atoms (identity/preference/constraint kinds from the atom@2 12-kind taxonomy) into
a profile document, refreshed incrementally as distill completes (reuse the
memory-events stream so the profile is itself event-sourced and explainable via
why_memory). Surface as `GET /profile` (+ `GET /agents/:agent/profile` already
exists for agent lessons — this is the user/global analog) and an MCP tool. Must
respect scope/privacy (private-by-default), supersede/invalidate lifecycle (a
retracted fact leaves the profile), and the CI eval gate (profile build must be
deterministic under the fake embedder).

**Out of scope:** no new vector table, no graph engine, no LLM re-summarization on
every write (batch/debounce the rebuild).

## Intake notes

Created from the 2026-07-09 competitor gap analysis (top-ranked gap). Priority is
unset — run `/runner:triage` (PM scoring + `backlog pm-apply`) to score before
slicing.

## Acceptance criteria (Given-When-Then)

- AC-1 (happy path): Given a set of high-confidence, durable, entity-typed atoms already persisted via typed distillation (identity/preference/constraint kinds per the atom@2 12-kind taxonomy referenced in the FEAT body) for an agent/user scope, When `GET /profile` is called for that scope, Then the response returns a profile document aggregating those atoms with why_memory-compatible provenance (source atom ids + evidence excerpt) for each field.
- AC-2 (architecture_quality weak dimension -- single choke point): Given a new memory is distilled and produces additional identity/preference/constraint atoms, When the post-distill event fires on the existing memory-events stream, Then the profile document is rebuilt via a debounced batch job (not synchronously on every write), and the aggregation logic lives in exactly one module with no duplicated query/rollup logic elsewhere in the codebase.
- AC-3 (product_completeness weak dimension -- lifecycle correctness): Given a profile-contributing atom is later superseded or invalidated through the existing lifecycle verbs, When the profile is next rebuilt, Then the retracted fact no longer appears in the profile document, and the removal is itself recorded as a memory_events entry so the profile stays explainable end to end.
- AC-4 (security weak dimension -- edge/error path): Given a caller requests `GET /profile` for a scope it is not authorized for (private-by-default), When the request is made without a matching Bearer token/scope, Then the response is `401` (unauthenticated) or `403` (unauthorized) and the error body leaks no profile data, including field names.
- AC-5 (observability weak dimension): Given a profile rebuild runs (debounced trigger or scheduled), When it completes, Then a structured log event or metric records rebuild duration, atom count consumed, and fields updated, so profile staleness and rebuild health are observable without a direct DB query.
- AC-6 (production_readiness weak dimension -- eval-gate determinism): Given the ADR-005 CI eval gate running under the deterministic fake embedder, When a profile rebuild is triggered inside that harness, Then the rebuild output is deterministic (no nondeterministic LLM re-summarization call in the rebuild path) and recall@10 >= 0.9 / NDCG@10 >= 0.7 are unchanged.
