---
id: FEAT-446
status: triaged
priority: P2
category: feature
target_release: null
created: 2026-07-08
updated: 2026-07-08
depends_on: []
slices: []
derived_from: null
tags: [stack:typescript, surface:api, concern:governance, cross-repo]
needs_contract: true
needs_ux: false
pm_customer_impact: 0.35
pm_effort_estimate: 0.7
pm_strategic_alignment: 0.4
pm_technical_risk: 0.85
pm_dependency_depth: 0.5
pm_composite_priority: P2
pm_autonomous_safe: false
pm_reviewed: 2026-07-08
autonomous_safe: false
triage_notes: "P2 via formula: impact 0.35 and alignment 0.40 are both below the P1 thresholds; effort 0.70 >= 0.70 satisfies half of the P3 condition but impact 0.35 is NOT <= 0.30 (a genuine near-miss on real numbers, not adjusted), so P3 doesn't fire either — lands P2 by default. composite_score=0.3425 (lowest of the five FEATs). technical_risk banded at 0.85 (top rubric band: 'Public/cross-plugin contract change... published artifact, hard-to-reverse effects') because the FEAT's own final step is cutting the first-ever sdk-v1 tag — an irreversible public action, independent of how well-tested the code underneath is. dependency_depth=0.50 reflects cross-repo execution plus coordination with the still-unresolved contracts/pgvector-vs-Qdrant convergence work named in tri-repo-plan.md. pm_effort_points=8 trips the FEAT-168 gate; I am NOT supplying proposed_slices (lack of cross-repo code visibility to responsibly decompose) and NOT setting composite_priority=needs-review (confirmed rejected by this runner version's VALID_PRIORITIES set) — submitting P2 with this gate-violation explicitly flagged in scopeNotes is the least-bad option among the three, and I am surfacing it rather than silently resolving it either direction. autonomous_safe=false is forced by technical_risk=0.85 > 0.6 alone (mechanical trigger, independent of the missing-AC rule), on top of being cross-repo work this loop cannot execute regardless."
---
## Description

SaaS SDK growth (memory repo): grow astramem-sdk (TypeScript) from its 4 methods (create/search/get/delete) to a publishable surface — memories CRUD+search, entities, decisions, session digest, and the daemon-compatible subset aligned with @astragenie/astramem-client so one SDK story targets both baseURLs; mirror to astramem-py where cheap; then first sdk-v1 tag (publish CI already exists, never triggered). Evidence: 2026-07-08 SaaS audit C — SDKs written, tested, never published; 4-method surface would set wrong expectations if tagged today.

## Intake notes

Created via free-text intake (`/runner:intake "<text>"`). Priority is
unset — this FEAT has not been scored yet. Run `/runner:triage`
(PM scoring + `backlog pm-apply`) to score it before slicing.