---
id: FEAT-467
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-10
updated: 2026-07-10
depends_on: []
blocks: [FEAT-458]
slices: []
derived_from: docs/adr/ADR-013-llm-proxy-auto-capture.md (Review decision 4, 2026-07-10)
cross_product: [astramem-local]
tags: ["concern:security", "concern:lifecycle", "stack:typescript", "surface:daemon"]
pm_customer_impact: 0.45
pm_effort_estimate: 0.5
pm_strategic_alignment: 0.72
pm_technical_risk: 0.5
pm_dependency_depth: 0.25
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-10
autonomous_safe: false
triage_notes: "P2 via formula (default branch): impact 0.45 < 0.70 so the (impact>=0.7 AND alignment>=0.6) P1 branch does not fire; alignment 0.72 < 0.80 so the (alignment>=0.8 AND effort<=0.4) P1 branch does not fire either (effort 0.5 also fails that branch's <=0.4 half independently); effort 0.5 < 0.70 so P3 does not fire. composite_score = 0.45*0.35 + 0.72*0.30 + (1-0.5)*0.20 + (1-0.5)*0.10 + (1-0.25)*0.05 = 0.561 — the highest composite of this 4-FEAT batch despite landing P2, because strategic_alignment is scored high (0.72): this is a formal, ADR-013-accepted hard blocker on FEAT-458 (LLM proxy auto-capture), with the operator security review explicitly rejecting re-acceptance of the weaker FEAT-455 posture for the higher-volume proxy tier. Direct customer_impact of THIS primitive alone is scored moderate (0.45), not high, because it is an internal lifecycle/audit mechanism, not a user-facing feature by itself — its value is almost entirely in unblocking FEAT-458. technical_risk banded at 0.5: touches invalidate() semantics used elsewhere in the lifecycle, needs a real reversal primitive (tombstone/soft-delete + restore, or exportable snapshot) plus durable audit records — moderate complexity, no schema-breaking change expected, but the FEAT's own text defers the reversal-mechanism design choice to FEAT-458 slice 1, meaning this ticket is not yet fully self-contained. dependency_depth scored 0.25: depends_on is empty, but the design-deferral to FEAT-458 slice 1 is a real (if soft) coupling not captured by depends_on alone. autonomous_safe=false: forced by the missing-AC gate — this triage pass drafts ACs only for FEAT-465/466 per the coordinator's scope, not for FEAT-467 — reinforced by the FEAT's own admission that the reversal-primitive design is intentionally left open pending FEAT-458 slice 1, making an unattended autonomous build premature regardless of the mechanical thresholds (risk 0.5, effort 0.5, dependency 0.25) all individually passing. Recommend scheduling this immediately before or alongside FEAT-458 slice 1 given the gate linkage, even though its formula priority lands P2."
---
## Description

**invalidate() reversal/audit gap — hard prerequisite for proxy auto-capture
(FEAT-458)** — the FEAT-455 spike (checklist #5) identified that the purge path
behind "disable auto-capture → retroactively remove captured content" rides on
`invalidate()` with no reversal primitive and incomplete audit: a purge cannot
be undone, and what exactly was purged is not fully reconstructable afterward.
Hook-tap (FEAT-455) shipped with this risk re-accepted. ADR-013's 2026-07-10
operator security review **rejected re-accepting it** for the proxy tier:
proxy capture volume makes a weak disable→purge promise a trust breach.

### Scope

- Reversal primitive: purge performed by the auto-capture disable flow must be
  reversible for a bounded window (tombstone/soft-delete generation with
  restore, or an exportable pre-purge snapshot) — design to be settled in
  FEAT-458 slice 1 (design gate) per ADR-013.
- Audit completeness: a purge writes a durable record of what was removed
  (ids, capture_source, time range, count) sufficient to verify the promise
  "turning it off removed what it captured."
- Applies to both `capture_source: 'auto_capture'` (hook-tap, retrofits the
  455 acceptance) and the future `'proxy'` value.

### Gate linkage

FEAT-458's capture fork MUST NOT ship before this FEAT is done (ADR-013
Review decisions, item 4). Belongs inside or immediately before FEAT-458
slice 1.

## Design note (settled in FEAT-458 slice 1, 2026-07-10)

Full rationale: `docs/specs/FEAT-458-S1-design.md` §1. Summary:

**Chosen mechanism: purge-batch soft-delete generation with a bounded restore
window** (not a pre-purge snapshot export) — the same `valid_to` + event-log
pattern `archive()`/`restore()` and `supersede()`/`unsupersede()` already use
in `src/storage/memory-events.ts`, applied a third time. Two new
`memory_events.event_type` values (`purge`, `unpurge`, widened via the same
create-copy-swap migration pattern migration 021 used for `unsupersede`) plus
one new small audit table, `purge_batches` (batch_id, capture_source,
requested_at, restore_deadline_at, atom_count, status, finalized_at) — the
per-batch audit record FEAT-467 requires (ids reconstructable from the
`purge` events tagged with that batch_id, so no separate ids array is
duplicated and can't drift from the event log).

Three new `MemoryEventRepo` methods: `purgeBatch()` (soft-invalidates the
matching atoms, opens a batch), `restorePurgeBatch()` (un-hides everything
still in the purged state for that batch, within the window), and
`finalizePurgeBatch()` (hard-erases via the existing unmodified `erase()`
once the window elapses without a restore — preserving ADR-006's "erasure
always wins, eventually" guarantee). Default restore window: 30 days,
configurable. Applies identically to `capture_source: 'auto_capture'`
(retrofits the FEAT-455 disable→purge flow, which today calls the
irreversible `erase()` path directly — see `src/cli/capture.ts:236-260`) and
`capture_source: 'proxy'` (FEAT-458), with the capture-source value as the
only scoping difference — no source-specific branching in the primitive
itself.

## Acceptance criteria

- **AC-1:** Given a disable flow requests a purge for a `capture_source`, When the purge executes, Then it creates a purge batch that soft-invalidates every matching atom via a new `purge` event type (never reusing `invalidate`) and persists a batch-level audit record — batch id, `capture_source`, atom count, and a restore-deadline time range — rather than hard-deleting any row.
- **AC-2:** Given an open purge batch within its restore window, When the batch's restore operation is invoked, Then every atom in the batch still in the purged state has `valid_to` cleared and an `unpurge` event appended, atoms independently changed by an unrelated lifecycle call since the purge are left untouched, and the batch's audit record is marked `restored`.
- **AC-3:** Given a purge batch whose restore window has elapsed with no restore call, When the finalize operation runs (explicit call or scheduled sweep), Then every still-purged atom in the batch is hard-erased via the existing unmodified `erase()` primitive (row, vector index, and FTS entry gone; `erase_request` tombstone appended) and the batch's audit record is marked `finalized`.
- **AC-4:** Given the purge/restore/finalize primitives, When a regression test exercises both outcomes, Then a purge followed by a same-window restore leaves the content fully searchable again, and a purge followed by finalize (or by simulated window expiry) leaves it permanently gone — both paths verified end to end, not asserted.
- **AC-5:** Given `capture_source` may be `'auto_capture'` (today) or `'proxy'` (FEAT-458), When either disable flow calls the purge primitive, Then the same reversible batch mechanism handles both values with the `capture_source` value itself as the only scoping difference — no `capture_source`-specific branching exists in the purge/restore/finalize code path.
- **AC-6:** Given an atom was hidden by a purge batch, When its lifecycle history is inspected (`GET /memory/:id/history` or the MCP `memory_history`/`why_memory` tools), Then the batch id and restore-deadline are visible on the `purge` event's payload, not just a bare state change indistinguishable from a manual `invalidate()`.
