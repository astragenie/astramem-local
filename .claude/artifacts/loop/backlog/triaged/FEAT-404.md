---
id: FEAT-404
status: pending
priority: null
category: null
target_release: null
created: 2026-07-03
updated: 2026-07-03
depends_on: []
slices: []
derived_from: null
github_issue: null
github_milestone: null
github_url: null
pm_customer_impact: 0.30
pm_effort_estimate: 0.40
pm_strategic_alignment: 0.40
pm_technical_risk: 0.65
pm_dependency_depth: 0.00
pm_effort_points: 5
composite_score: 0.4825
composite_priority: P2
autonomous_safe: false
pm_demand_evidence: "none - 'SQLite grows unbounded today' (FEAT-404 body) is a repo-observed fact, not a named stakeholder complaint. customer_impact capped <=0.3."
pm_scope_notes: "Smallest deliverable: archive-flag mechanics reusing supersede (existing pattern) with a single fixed policy default, deferring configurable thresholds if halved. Overlap check: reuses existing supersede mechanics per FEAT body - no duplicate capability. AC quality: vague on concrete values - 'age threshold (months) + usefulness floor' names no default numbers (e.g. 6 months, floor 0.2); per authoring.md AC-quality checklist this is not yet testable without a builder inventing the policy numbers themselves, which is a design decision PM should not fabricate. Recommend architect/human sets concrete defaults before this is autonomous-safe. No grade history / no cost analog available."
pm_risks:
  - "Pre-mortem: most likely failure cause is the archival policy silently archiving atoms still in active use by a low-frequency-but-high-value workflow (usefulness floor doesn't distinguish 'rarely used' from 'rarely needed but critical'), causing user-visible recall regressions with no obvious cause."
  - "Rollback: needs migration/state cleanup. Adding an archive flag column (implied by 'archive flag' in the AC) is a schema change; even though restore is designed to be non-destructive, a bad rollout requires a data cleanup pass (un-archiving), not a plain git revert."
  - "Coverage gap: no existing test covers the policy-off vs policy-on snapshot comparison the AC requires, nor a case where an atom crosses the age threshold but not the usefulness floor (or vice versa) - AC must add both boundary cases."
reasoning: "Technical_risk band 0.6-0.8 (schema/data-shape change via archive flag, rollback needs cleanup not just revert); autonomous_safe=false because AC lacks concrete policy defaults (age threshold, usefulness floor) - a design decision, not an implementation detail, needed before this is safe to hand to a builder."
---
# FEAT-404: Memory TTL / archival tiers (W4.4)

## Description

SQLite grows unbounded today. Add a policy where stale, low-usefulness atoms
auto-archive after N months (valid_to + archive flag). Archived memories are
excluded from vec/FTS candidate sets but remain restorable — nothing is destroyed.

## Acceptance criteria (Given / When / Then)

**AC-1** Given `archival.enabled=false`, When the cleanup cadence fires, Then no memory is archived (snapshot identical to today).
**AC-2** Given enabled + a memory older than the age threshold AND with usefulness below the floor, When cleanup runs, Then it gets `valid_to` set + archive flag and is excluded from vec/FTS candidate sets.
**AC-3** Given a memory older than the threshold but with usefulness at/above the floor, When cleanup runs, Then it is NOT archived (both conditions required).
**AC-4** Given an archived memory, When restore runs on it, Then it returns to active candidate sets and reappears in search results.
**AC-5** Given any archival run, When the DB is inspected, Then zero rows are deleted — archival is non-destructive and reuses supersede mechanics (row count unchanged, only flags/valid_to change).
**AC-6** Given the policy defaults, When config is read, Then concrete defaults exist (proposal: age = 6 months, usefulness floor = rate_7d ≤ 0.0) rather than null — resolves the PM-flagged missing-defaults gap.

## Notes

Roadmap W4.4. Complexity: Med — policy design is the hard part; mechanics reuse
supersede. Est 6–10h. Suggested activation order: 5th.
