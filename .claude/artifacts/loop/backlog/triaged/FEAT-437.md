---
id: FEAT-437
status: triaged
priority: P2
category: platform
target_release: null
created: 2026-07-07
updated: 2026-07-07
depends_on: []
slices: []
derived_from: ops-investigation-2026-07-07
tags: [concern:maintainability, surface:consolidation, surface:dashboard, surface:api]
pm_customer_impact: 0.60
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.55
pm_technical_risk: 0.65
pm_dependency_depth: 0.15
pm_effort_points: 5
composite_score: 0.54
composite_priority: P2
autonomous_safe: false
pm_demand_evidence: "Ops evidence, quoted from triage_notes: '/health shows 158 pending consolidation merge proposals with zero review throughput.' Body: '158 pending as of 2026-07-07, all kind: merge, throughput zero.' Confirmed the accept/reject surface is real and small: src/server/routes/consolidation.ts is 79 lines (list/accept/reject already exist)."
pm_scope_notes: "Independent. Smallest deliverable if scope halved: ship only the digest/dashboard visibility (count + oldest age) and the bulk CLI action for the standing 158, WITHOUT the auto-accept threshold — that alone drains the backlog under human control and defers the irreversible-merge risk. If forced to cut further, the bulk action for the existing 158 is the one thing that must stay. AC tightening needed before a future P1/--deep pass: (1) default-preserved happy path, (2) auto-accept + memory_events provenance tagging as auto_accepted:true, (3) below-threshold digest/dashboard visibility, (4) bulk resolution for the standing 158 with distinct provenance, (5) config-validation failure on an out-of-range threshold."
pm_risks:
  - "Pre-mortem (technical_risk=0.65): an auto-accepted merge at/above the similarity threshold destroys a memory that was semantically distinct despite high embedding similarity (near-duplicate phrasing, different truth values or dates) — the default-off config knob protects nobody once an operator sets a real threshold without an eval pass on the specific corpus."
  - "Pre-mortem: rollback for the auto-accept CODE is a trivial git revert (default off), but rollback for ALREADY-AUTO-ACCEPTED merges is NOT — consolidation merges mutate the memories table destructively; undoing a bad auto-accept run requires restoring from a pre-merge backup/snapshot, i.e. state cleanup, not a code revert."
  - "Pre-mortem: existing consolidation tests validate the manual accept/reject API path only; none exercise a threshold-driven bulk/periodic sweep at the live 158-item backlog scale, and none assert that memory_events provenance distinguishes auto-accepted from manually-accepted merges."
reasoning: "P2 via formula: impact 0.60 short of the 0.7 P1 threshold, alignment 0.55 short of the 0.8 alternate — active product-quality debt (dead-weight dedup feature, growing queue) rather than an active outage. autonomous_safe false mechanically (technical_risk 0.65>0.6): auto-accept is an irreversible data-mutation feature — any enabled threshold needs human sign-off on the value and the bulk-resolution UX before an autonomous pass touches it."
triage_notes: "Ops finding 2026-07-07: /health shows 158 pending consolidation merge proposals with zero review throughput — the accept/reject surface exists (/consolidation/proposals + dashboard) but nothing drives resolution, so the queue only grows. Without a policy the dedup feature is dead weight: near-duplicate memories keep serving in search while their merge proposals rot."
---

# FEAT-437: consolidation proposal backlog policy — auto-accept threshold + digest surfacing

## Problem
The consolidation pipeline generates merge proposals (near-duplicate memories,
similarity ~0.9+) but resolution is fully manual and nobody drives it: 158
pending as of 2026-07-07, all `kind: merge`, throughput zero. The backlog grows
unbounded and the dedup feature delivers no value while proposals sit pending.

## Requested capability
A resolution policy so the queue trends to zero without a human clicking 158
times:
- auto-accept merges above a configurable similarity threshold (e.g.
  `consolidation.autoAcceptSimilarity: 0.95`, default off) — applied by the
  worker on proposal creation or by a periodic sweep;
- proposals below threshold surface in the digest / dashboard with a count and
  age so the backlog is visible instead of buried in `/health.pending_proposals`;
- a bulk accept/reject CLI or dashboard action for the existing 158.

## Acceptance (proposed — re-triage)
- Config knob exists, default preserves current behavior (no auto-accept).
- With threshold set, a new proposal at/above it resolves without manual action;
  memory_events record the merge with provenance marking it auto-accepted.
- Pending-proposal count + oldest-age visible in digest or dashboard home.
- Bulk resolution path exists for the standing backlog.

## Refs
- Routes: `src/server/routes/consolidation.ts` (list/accept/reject already exist).
- Ops evidence: /health `pending_proposals: 158`, session 2026-07-07.
