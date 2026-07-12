---
id: FEAT-443
status: done
priority: P2
category: feature
target_release: null
created: 2026-07-08
updated: 2026-07-08
depends_on: []
slices: []
derived_from: null
tags: [stack:typescript, surface:infra, concern:observability]
needs_contract: true
needs_ux: false
pm_customer_impact: 0.55
pm_effort_estimate: 0.65
pm_strategic_alignment: 0.55
pm_technical_risk: 0.55
pm_dependency_depth: 0.15
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-08
autonomous_safe: false
triage_notes: "Reconciliation entry only — scores, composite_priority, and autonomous_safe are unchanged from my original 20260708T134432Z analysis (see that artifact for the full formula walkthrough). The only change is proposedSlices, updated to match the peer session's already-rendered body content (5pts pointer/rollback-port slice + 5pts watchdog slice, sum=10 >= effort_points=8) instead of my originally-submitted per-platform split, to eliminate a frontmatter/body inconsistency neither PM run could have anticipated without knowing about the other's concurrent write."
proposed_slices:
  - id_suffix: -SLICE-1
    title: Systemd/launchd pointer-indirection + rollback port
    points: 5
  - id_suffix: -SLICE-2
    title: Hang-watchdog equivalent (sd_notify/WatchdogSec + launchd analog)
    points: 5
---
## Description

Unix service parity: port the Windows release-pinned pointer-indirection + rollback architecture to systemd/launchd (upgrades stop rewriting unit/plist files; reinstall --rollback works off-Windows), and add a hang-watchdog equivalent (systemd WatchdogSec + sd_notify or timer-based re-exec; launchd equivalent). Today src/service/install-flow.ts:74-84 bakes absolute release paths into units on non-Windows and restorePriorPointer is a Windows-only safety net; systemd Restart=on-failure catches crashes but never hangs. Evidence: 2026-07-08 cross-platform audit (release blocker doc'd as honest asymmetry at launch).

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.
## Proposed slices (PM decomposition)

- SLICE-1: Systemd/launchd pointer-indirection + rollback port (5 pts)
- SLICE-2: Hang-watchdog equivalent (sd_notify/WatchdogSec + launchd analog) (5 pts)

## Closure note (2026-07-12)

Both slices merged (systemd/launchd pointer-indirection + rollback port;
watchdog probe with stopLockHolder-failure fix 581cc65, internal review
APPROVED, 294/294 service+cli tests). Merged via 2377cf2 (merge concluded
out-of-ceremony — content validated post-merge on main: build clean,
328/328 service+consolidate+cli green). RESIDUAL: live systemd/launchd
validation needs a real Linux/macOS host — unit/plist generation is
snapshot-tested only.
