---
id: FEAT-451
status: done
priority: P1
category: feature
target_release: null
created: 2026-07-09
updated: 2026-07-09
depends_on: []
slices: []
derived_from: docs/research/2026-07-09-competitor-gap-analysis.md
cross_product: [astramem-local]
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
output. The local extractor currently emits only 7 atom kinds — decision, fact,
lesson, command, todo, note, event (src/distill/prompts/extract.ts:28) — there is
no identity/preference/constraint semantic taxonomy today; `preference` exists only
in the cloud contract (src/contracts/memory.ts:17-21) and is never produced by the
local extractor. A prerequisite extraction-schema change (new atom kind(s) and/or a
tagging layer) is required before any rollup logic can select "profile-worthy"
atoms. Roll up the resulting high-confidence, durable atoms into a profile — either
computed live at read time (precedent: `GET /agents/:agent/profile` is a pure
read-time query with no persisted document, src/server/queries/agent-profile.ts) or
as a persisted document (a genuinely new storage primitive, which would contradict
this FEAT's own "no new storage primitive" scope note below). That choice must be
made explicitly before slicing — see the architecture-review corrections section.
Surface as `GET /profile` (+ `GET /agents/:agent/profile` already exists for agent
lessons — this is the user/global analog) and an MCP tool. Must respect
scope/privacy (private-by-default), supersede/invalidate lifecycle (a retracted
fact leaves the profile), and the CI eval gate (profile build must be deterministic
under the fake embedder).

**Product scope:** local-only for now (`cross_product: [astramem-local]`). Cloud
parity is deferred pending the wire-contract decision — profile-worthy atom tagging
must be settled and shipped locally before it can be proposed as a shared contract
addition.

**Out of scope:** no new vector table, no graph engine, no LLM re-summarization on
every write (batch/debounce the rebuild IF the persisted-document design is chosen).

## Intake notes

Created from the 2026-07-09 competitor gap analysis (top-ranked gap). Priority is
unset — run `/runner:triage` (PM scoring + `backlog pm-apply`) to score before
slicing.

## Acceptance criteria (Given-When-Then)

- AC-1 (happy path): Given a set of high-confidence, durable atoms already persisted via typed distillation and tagged profile-eligible by the new extraction-schema change this FEAT prerequires (NOT an existing identity/preference/constraint taxonomy — see corrections section) for an agent/user scope, When `GET /profile` is called for that scope, Then the response returns a profile document aggregating those atoms with why_memory-compatible provenance (source atom ids + evidence excerpt) for each field.
- AC-2 (architecture_quality weak dimension -- single choke point): Given a new memory is distilled and produces additional profile-eligible atoms, When per-atom create events land on the existing memory-events stream (there is no "distill run completed" event to trigger from — only per-atom create events), Then the profile is refreshed via a debounced batch job over those events if the persisted-document design is chosen, or recomputed at read time with no rebuild step if the live-computed design is chosen, and either way the aggregation logic lives in exactly one module with no duplicated query/rollup logic elsewhere in the codebase.
- AC-3 (product_completeness weak dimension -- lifecycle correctness): Given a profile-contributing atom is later superseded or invalidated through the existing lifecycle verbs, When the profile is next read or rebuilt, Then the retracted fact no longer appears in the profile document, and the removal is itself recorded as a memory_events entry so the profile stays explainable end to end.
- AC-4 (security weak dimension -- edge/error path): Given the daemon's current auth model is one global Bearer token with no per-scope/per-caller authorization primitive (verified — no scoped-auth mechanism exists today), When a caller requests `GET /profile` without a valid Bearer token, Then the response is `401` and the error body leaks no profile data, including field names; per-scope authorization (rejecting an authenticated-but-wrong-scope caller) is NOT achievable under today's auth model and is a dependency to flag, not a claimable 403 path, until a scoped-auth primitive exists.
- AC-5 (observability weak dimension): Given a profile rebuild or recompute runs, When it completes, Then a structured log event or metric records duration, atom count consumed, and fields updated, so profile staleness and rebuild/recompute health are observable without a direct DB query.
- AC-6 (production_readiness weak dimension -- eval-gate determinism): Given the ADR-005 CI eval gate running under the deterministic fake embedder, When a profile rebuild/recompute is triggered inside that harness, Then the output is deterministic (no nondeterministic LLM re-summarization call in the path) and recall@10 >= 0.9 / NDCG@10 >= 0.7 are unchanged.

## Architecture review corrections (2026-07-09)

The original FEAT body asserted an "identity/preference/constraint" atom taxonomy
that does not exist in this codebase. Corrected facts:

- `ENTITY_KINDS` (src/contracts/entity.ts:14-27) categorizes named entities mentioned
  IN atoms (actor|team|org|...) — it is not an atom semantic-kind taxonomy at all.
- The local extractor emits exactly 7 atom kinds: decision, fact, lesson, command,
  todo, note, event (src/distill/prompts/extract.ts:28).
- `preference` is cloud-only and never produced by the local extractor
  (src/contracts/memory.ts:17-21).
- **A prerequisite extraction-schema change is required** before profile-eligible
  atoms can be selected at all.
- **Live-computed vs. persisted document is an open, unresolved design question.**
  Precedent for live-computed: `GET /agents/:agent/profile` is a pure read-time
  query (src/server/queries/agent-profile.ts), no persisted document. A persisted
  document is a new storage primitive, contradicting the FEAT's own "no new storage
  primitive" scope note. AC-2's "debounced batch rebuild" only makes sense under the
  persisted design — pick one before slicing.
- There is no "distill run completed" event on `memory_events` — only per-atom
  create events. Any rebuild trigger must be designed against that reality.
- AC-4 authz as originally written assumed per-scope caller authorization the
  daemon does not have: there is one global Bearer token, no per-scope auth.
- Rollup provenance (N:1 merge-and-cite across multiple source atoms into one
  profile field) is new work, not a reuse of existing why_memory plumbing.
- Product scope: declared local-only (`cross_product: [astramem-local]`); cloud
  parity deferred pending the extraction-schema and storage-design decisions above.

## Shipped (2026-07-10)
Slice 1 merged to main (0f52351, review PASS): live-computed GET /profile + MCP
user_profile (18th tool). Slice 2 (local `preference` atom kind) deferred by
design — needs prompt A/B first. Non-blocking review follow-ups: (1) MEDIUM —
per-request queries scan the full active set (no type/scope index, no SQL
LIMIT); add an index + LIMIT when read volume warrants (agent-profile
migration-019 precedent). (2) LOW — share VALID_PROFILE_SCOPES between
user-profile.ts and mcp/server.ts.
