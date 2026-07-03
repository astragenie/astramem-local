---
id: FEAT-407
status: pending
priority: null
category: null
target_release: null
created: 2026-07-03
updated: 2026-07-03
depends_on: [FEAT-408]
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
pm_customer_impact: 0.25
pm_effort_estimate: 0.85
pm_strategic_alignment: 0.55
pm_technical_risk: 0.85
pm_dependency_depth: 0.50
pm_effort_points: 21
composite_score: 0.3325
composite_priority: needs-review
autonomous_safe: false
pm_demand_evidence: "none - multi-device sync pull is a speculative future capability named in the roadmap ('Enables a device to receive memories created elsewhere'), no stakeholder quote. customer_impact capped <=0.3."
pm_scope_notes: "Decomposition gate (FEAT-168): pm_effort_estimate 0.85 maps to 21 effort_points (>=8), which normally requires a proposed_slices block. Declining to propose slices here (Framework 6, option 2) because the shape of the work is genuinely undetermined until FEAT-408's conflict policy (LWW vs event-merge) is chosen - the merge/conflict-handling slice would look structurally different under each option, so any slice split PM writes now would likely be thrown away. Setting composite_priority=needs-review per the gate's explicit option 2 instead of inventing a confident slice plan. Re-triage once FEAT-408 lands with a chosen policy. No grade history / no cost analog available; 'Est 20h+' in FEAT body has no comparable past slice to calibrate against."
pm_risks:
  - "Pre-mortem: most likely failure cause is building the pull/merge protocol against an assumed conflict policy that FEAT-408 ultimately does not choose, requiring a rewrite of the merge logic after design lands - this is exactly why the FEAT is hard-blocked."
  - "Rollback: cross-plugin/protocol coordination required. This touches the wire contract between local daemon and the cloud SaaS backend (bidirectional now, not just push) - a bad rollout is not a simple git revert on this repo alone; it needs coordination with the SaaS-side event/watermark contract."
  - "Coverage gap: no existing test exercises idempotent replay of pull events or watermark persistence across restarts - both are named in the AC and have no current coverage to regress against."
reasoning: "Hard-blocked by depends_on: [FEAT-408] (unresolved), so autonomous_safe=false per the explicit rule that a blocked FEAT cannot score autonomous_safe=true. technical_risk band 0.9-1.0 (cross-service/cross-plugin wire-contract change, hard-to-reverse without SaaS-side coordination, unknowns needing FEAT-408's spike first). effort_points=21 triggers the decomposition gate but scope genuinely resists decomposition pending the FEAT-408 design output, so composite_priority=needs-review per Framework 6 option 2 rather than P0-P3."
---
# FEAT-407: Sync bidirectional pull (W4.7)

## Description

The shipper is one-way append-only push today. Add pull — cloud→local merge with
a conflict policy. Enables a device to receive memories created elsewhere, not just
send its own.

## Acceptance criteria (Given / When / Then)

**AC-1** Given cloud events newer than the last local watermark, When `sync pull` runs, Then those memories are merged locally and the watermark advances past them.
**AC-2** Given the same event batch replayed, When `sync pull` re-runs, Then no memory is duplicated (idempotent, keyed by event id).
**AC-3** Given a conflict (same memory edited on two devices), When pull merges, Then resolution follows FEAT-408's chosen policy deterministically.
**AC-4** Given a daemon restart mid-sync, When pull resumes, Then the persisted watermark/cursor is honored (no re-pull from zero, no gap).
**AC-5** Given device A pushes memory M and device B pulls, When pull completes on B, Then B holds M with an identical content hash.
**AC-6** Given the SaaS-side event/watermark contract, When pull is implemented, Then the local↔cloud wire change is additive and version-gated (no break to existing one-way push clients).

Blocked-by: FEAT-408 must land a chosen conflict policy first (AC-3 depends on it). Do not build until 408's ADR is accepted.

## Notes

Roadmap W4.7. Complexity: High — protocol + idempotency + conflict semantics.
Est 20h+. Hard prereq: FEAT-408 (conflict policy) must land first. Suggested
activation order: last (9th) — sync depends on conflict design.
