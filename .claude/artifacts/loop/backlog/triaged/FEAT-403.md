---
id: FEAT-403
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
pm_effort_estimate: 0.28
pm_strategic_alignment: 0.50
pm_technical_risk: 0.40
pm_dependency_depth: 0.00
pm_effort_points: 3
composite_score: 0.563
composite_priority: P2
autonomous_safe: true
pm_demand_evidence: "none - no direct user complaint; roadmap frames this as an enabler ('makes scoping + entity search trustworthy', docs/hardening-roadmap.md:57) rather than a standalone pain point. customer_impact capped <=0.3."
pm_scope_notes: "Smallest deliverable: session-meta heuristic tier only (tier 1), defer prompt-assisted tier 2 fallback if halved. No overlap with existing FEATs. AC quality: dry-run mode and idempotency are concrete and testable; tier-2 'prompt-assisted heuristics' has no concrete confidence threshold or acceptance criteria for when to trust an LLM-inferred tag over leaving it untagged - flagging as an open question for the builder rather than inventing a threshold. No grade history / no cost analog available (both artifact directories are empty/template-only)."
pm_risks:
  - "Pre-mortem: most likely failure cause is the prompt-assisted (tier 2) fallback mis-tagging a memory to the wrong project when session metadata is ambiguous or missing, silently corrupting scoping data it was meant to fix."
  - "Rollback: revert-only for the job code itself, but the backfill's writes are data mutations on existing rows - reverting the CLI does not undo already-applied tags. AC's dry-run mode is the primary safety net; a restore-from-backup would be needed to undo a bad live run."
  - "Coverage gap: no existing test exercises the idempotency claim ('re-running does not re-tag already-tagged rows') under a mixed corpus of tagged/untagged/partially-tagged rows - AC must add this mixed-state case."
reasoning: "Low-med effort one-shot backfill; technical_risk band 0.3-0.5 (new heuristic pattern in one module, no schema change, but data-mutating so rollback needs restore not just revert). autonomous_safe=true given dry-run safety net and idempotency requirement in AC."
---
# FEAT-403: Repo/project tag hygiene (W4.3)

## Description

Backfill repo/project tags onto untagged legacy memories so scoping and entity
search are trustworthy. A `rebuild --retag`-style one-shot pass that infers
repo/project from session metadata where present, else prompt-assisted heuristics.

## Acceptance criteria (Given / When / Then)

**AC-1** Given memories with null/empty repo/project and session metadata present, When retag runs, Then repo/project are derived from session cwd/project_id (tier-1 heuristic).
**AC-2** Given `--dry-run`, When retag runs, Then proposed tags are printed and zero rows are mutated (verified by row-hash before/after).
**AC-3** Given a corpus already fully tagged, When retag re-runs, Then zero rows change (idempotent — re-run is a no-op).
**AC-4** Given ambiguous or missing session metadata, When the tier-2 prompt-assisted inference returns confidence < 0.7, Then the memory is left untagged rather than mis-tagged (resolves the open threshold — default 0.7, config-overridable).
**AC-5** Given a mixed corpus (tagged + untagged + partially-tagged rows) and a retagged Postgres project, When project-scoped search runs, Then no cross-project memory (e.g. a SQLite-decision atom) leaks into results.

## Notes

Roadmap W4.3. Complexity: Low-med (one-shot job + heuristics). Est 4–6h.
Enables trustworthy entity scoping (W4.2). Suggested activation order: 3rd.
