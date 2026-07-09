---
id: FEAT-451
status: pending
priority: null
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
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
