---
id: FEAT-456
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
pm_customer_impact: 0.45
pm_effort_estimate: 0.62
pm_strategic_alignment: 0.6
pm_technical_risk: 0.6
pm_dependency_depth: 0.3
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-09
autonomous_safe: false
triage_notes: "technical_risk 0.6 sits at the entry of the 0.6-0.8 band (cross-module pairing+judge+write-path reach, plus cross-service mirroring; no schema change since it reuses the existing supersede event type, and the design is reversible-by-construction via restore, which keeps it at the low end of the band rather than higher). Reinforces FEAT-451/453 but is itself effort-heavy and touches the same entity-lifecycle surface those slices touch -- P2, autonomous_safe false given the state-mutation cascade risk and decomposition requirement; recommend sequencing after FEAT-453 per the FEAT's own note."
proposed_slices:
  - id_suffix: -SLICE-1
    title: "Contract: auto_contradiction supersede-reason discriminator"
    points: 2
  - id_suffix: -SLICE-2
    title: "Local: pairing + judge + auto-supersede + guard rails"
    points: 5
  - id_suffix: -SLICE-3
    title: "Cloud: mirror contradiction-detection stage + event parity"
    points: 3
---
## Description

**Contradiction detection → propose-only consolidation proposal (NOT automatic
supersede).**

**BLOCKER, fixed by rewriting the approach:** the original "auto-supersede the
stale atom directly" design contradicted ADR-004 stage 9(c)
(docs/adr/ADR-004-formation-pipeline.md:27-28: contradiction handling is
PROPOSE-ONLY; "auto-invalidation is trust-destroying") and would have duplicated
schema already built for exactly this feature —
`ConsolidationProposal.kind` already includes `'contradiction'`
(src/consolidate/proposals.ts:14, defined but never yet produced), and
`runConsolidation`'s own comment already earmarks stage 9(b)/(c) to reuse the
proposal queue (src/consolidate/consolidate.ts:22-24). The corrected design below
emits proposals into that existing queue instead of mutating memories directly.

Today `supersede` and `invalidate` are manual, and consolidation surfaces
*proposals* (ADR-004) a human/agent must resolve. Add **automatic contradiction
detection**: when a newly-distilled atom conflicts with an existing high-confidence
atom, detect it and emit a `kind: 'contradiction'` row into the existing
`consolidation_proposals` queue for review — v1 is propose-only, matching every
other proposal kind ADR-004 already ships.

**Why:** mem0 and Zep detect when new info contradicts stored info. Without this,
memory silently accumulates contradictions and recall returns stale facts alongside
their corrections. Directly reinforces FEAT-451 (profile stays consistent) and
FEAT-453 (fact-level validity) — soft sequencing constraint only, not a hard
`depends_on`; don't parallelize their migration slices, but no schema dependency
otherwise.

### Detection approach (shared design)
- Candidate pairing: reuse the existing pairwise cosine similarity scan
  (src/consolidate/consolidate.ts:303-390) — this is not new plumbing, it is the
  same neighbor-finding logic consolidation already runs.
- Conflict judgment: a local LLM judge classifies each pair as
  {agrees, refines, contradicts, unrelated}. Only `contradicts` produces a proposal.
- Action (v1): emit a `kind: 'contradiction'` row into the EXISTING
  `consolidation_proposals` table via the existing `ProposalRepo` /
  `mergeAsSupersede` audit-trail path — propose-only, exactly like every other
  proposal kind. NEVER auto-mutate memories in v1.
- Action (v1.x, later): any auto-action tier reuses the FEAT-442
  `autoAcceptThreshold` pattern — but note FEAT-442's auto-accept was justified by
  a **deterministic cosine-similarity** signal, not a **probabilistic LLM judge**;
  that justification does not transfer automatically and needs its own case made
  before any auto-action tier ships.

### Local scope (astramem-local, TS)
- New post-distill stage that runs the pair→judge→propose flow, writing into the
  existing consolidation proposal queue; reuse the existing pairwise cosine scan
  (src/consolidate/consolidate.ts:303-390) and the distill LLM provider for the
  judge.
- Config: `consolidation.contradictionDetection { enabled, minConfidence, maxPerRun }`,
  default OFF.
- Determinism: judge stubbed via the existing mock-LLM-provider pattern
  (src/pipeline/mock-providers.ts) — NOT ADR-005's fake embedder, which stubs
  embeddings, not LLM judgments; these are different determinism mechanisms for
  different call types.
- Dry-run/report mode: a way to see what would be proposed without writing
  proposals, for safe rollout.

### Cloud scope (memory, .NET 10)
- Same detection stage server-side for SaaS-ingested content that didn't pass
  through a local daemon; honor the same thresholds; emit the same
  `kind: 'contradiction'` proposal type so history is uniform across products.
- **New hard AC:** `unsupersede` events are currently EXCLUDED from sync ship
  (src/sync/shipper.ts:137,155,202), so a local reversal of an (eventual) auto- or
  human-resolved contradiction never reaches cloud today. This gap must be fixed,
  or explicitly risk-accepted in writing, before any cloud mirroring of
  contradiction resolution ships.

### Shared contract impact (`@astragenie/astramem-contracts`)
- Reuse the existing `ConsolidationProposal.kind: 'contradiction'` type
  (already defined, src/consolidate/proposals.ts:14) — no new discriminator field
  needed on the supersede event itself, since v1 never writes a supersede event
  directly.

### Approximate ETA (1 dev)
- Local: pairing (reused) + judge + propose-only write path + guard rails + eval
  determinism + dry-run mode: **~4–5d**
- Cloud: mirror stage + event parity + shipper unsupersede-gap decision: **~3–4d**
- **Total ≈ 1.5–2 weeks.** Soft sequencing with FEAT-453 (shared entity-lifecycle
  surface — don't parallelize the migration slices, no hard dependency). Ship with
  default OFF and the dry-run/report mode before enabling any proposal generation.

## Intake notes
From 2026-07-09 competitor gap analysis (gap #6). Applies to BOTH products. Reversible
by construction (event-sourced, propose-only). Unscored; run `/runner:triage`.

## Proposed slices (PM decomposition)

- SLICE-1: Contract: none needed — reuse existing `ConsolidationProposal.kind: 'contradiction'` (2 pts)
- SLICE-2: Local: pairing (reuse) + judge + propose-only write + guard rails + dry-run mode (5 pts)
- SLICE-3: Cloud: mirror contradiction-detection stage + proposal parity + shipper unsupersede-gap decision (3 pts)

## Architecture review corrections (2026-07-09)

**Blocker, fixed:** the original "auto-supersede directly" design contradicted
ADR-004 stage 9(c) (docs/adr/ADR-004-formation-pipeline.md:27-28 — contradiction
handling is PROPOSE-ONLY; "auto-invalidation is trust-destroying") and would have
duplicated schema already purpose-built for this feature:
`ConsolidationProposal.kind` already has `'contradiction'`
(src/consolidate/proposals.ts:14, never yet produced), and
`runConsolidation`'s comment already says stage 9(b)/(c) will reuse the proposal
queue (src/consolidate/consolidate.ts:22-24). Rewritten to emit `kind:
'contradiction'` proposals into the existing `consolidation_proposals` table via
the existing `ProposalRepo`/`mergeAsSupersede` audit trail; v1 is propose-only; any
auto-action tier is v1.x work reusing the FEAT-442 `autoAcceptThreshold` pattern
(noting FEAT-442's auto-accept was justified by deterministic cosine similarity,
not a probabilistic LLM judge — that justification doesn't transfer automatically).

Pairing reuses the existing pairwise cosine scan
(src/consolidate/consolidate.ts:303-390) rather than new plumbing.

Corrected the eval-determinism claim: judge determinism uses the mock-LLM-provider
pattern (src/pipeline/mock-providers.ts), NOT ADR-005's fake embedder (which stubs
embeddings, a different call type).

Added hard ACs: (a) the unsupersede/shipper gap — unsupersede events are excluded
from sync ship (src/sync/shipper.ts:137,155,202), so a local reversal never
reaches cloud; fix or explicitly accept before any cloud mirroring; (b) a
judge-accuracy eval fixture; (c) dry-run/report mode.

Sequencing vs FEAT-453: confirmed soft constraint only ("don't parallelize the
migration slices"), not a hard `depends_on`.

## Shipped (2026-07-10)
SLICE-1 merged (review PASS, 2094 tests): propose-only contradiction detection
in the consolidate pair loop, kind:'contradiction' proposals, migration 022
metadata_json, mock-judge determinism fixture. Default OFF. SLICE-2 shipped 2026-07-10 (review PASS). Was: (MCP/
digest surfacing) remains. INFO follow-up: POST /consolidation/run doesn't
wire the judge (job handler only) — intentional SLICE-1 scope, future slice.

SLICE-2 shipped 2026-07-10 (merge, review PASS): kind filter (repo/REST/MCP), contradiction_metadata on list tool, session_digest pending_contradictions, dashboard badge. LOW follow-ups: junk-kind + malformed-metadata tests.
