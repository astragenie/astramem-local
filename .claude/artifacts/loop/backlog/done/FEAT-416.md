---
id: FEAT-416
status: done
completed: 2026-07-04
priority: P1
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: arch-review-2026-07-04
pm_customer_impact: 0.55
pm_effort_estimate: 0.25
pm_strategic_alignment: 0.50
pm_technical_risk: 0.20
pm_dependency_depth: 0.20
pm_effort_points: 2
composite_score: 0.64
composite_priority: P1
autonomous_safe: true
pm_demand_evidence: "MemoryEventRepo.restore() exists but is unreachable from any route/CLI/MCP surface (Phase-1 inventory gap 2). W4.4 (memory TTL/archival) already SHIPPED in Wave 4, so this is now a real, current usability gap — operators can archive but never un-archive."
pm_scope_notes: "Smallest deliverable: POST /memory/:id/restore mirroring existing lifecycle route patterns (invalidate/supersede/promote) + one CLI flag. MCP tool exposure is optional/stretch."
pm_risks:
  - "Low — additive route following an established pattern; main risk is inconsistent 404/409 semantics vs sibling lifecycle routes if not copied carefully."
reasoning: "Cheap, low-risk, closes a half-implemented feature that's now live-relevant since archival TTL shipped in Wave 4. Straightforward P1: real current gap, well-understood fix, small footprint."
---
# FEAT-416: Expose restore (un-archive) through a surface

## Problem
MemoryEventRepo.restore() exists but nothing calls it — no route, no CLI, no MCP tool. Archival TTL pass can archive memories; operators can never un-archive through any surface. Half-implemented lifecycle feature.

## Acceptance (PM GWT)
1. Given an archived memory and a valid Bearer token, When a client calls POST /memory/:id/restore, Then the archived state clears and the memory reappears in current-snapshot search/recall.
2. Given a non-existent or never-archived memory id, When restore is called, Then it returns 404/409 semantics consistent with existing lifecycle routes.
3. Given a restore occurs, When GET /memory/:id/history is queried, Then memory_events shows the restore event.
4. Given the CLI, When an operator runs the new restore command/flag, Then it calls the route and reports success/failure clearly.
5. Given route-level tests mirroring lifecycle.test.ts, When the suite runs, Then restore is covered for success, 404, and 409 cases.
6. (Optional) Given an MCP client invokes a restore_memory tool if added, When called, Then behavior matches the REST route.

## Evidence
Phase-1 inventory gap 2; architecture review debt rank 3 ("one route closes it").


## Resolution (2026-07-04, Wave A)
Restore surface merged e12437d: POST /memory/:id/restore (invalidate-mirrored 404/409), CLI `memory restore <id>` (new subcommand group — no lifecycle CLI precedent existed), restore_memory MCP tool (count 15). Review PASS, no findings above LOW.

