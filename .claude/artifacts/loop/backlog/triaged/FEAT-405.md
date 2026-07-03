---
id: FEAT-405
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
pm_customer_impact: 0.20
pm_effort_estimate: 0.05
pm_strategic_alignment: 0.25
pm_technical_risk: 0.10
pm_dependency_depth: 0.00
pm_effort_points: 1
composite_score: 0.55
composite_priority: P1
autonomous_safe: true
pm_demand_evidence: "none - no user complaint quote found; roadmap frames this as an operator convenience ahead of the existing 30-day auto-purge (src/pipeline/handlers/cleanup.ts, src/cli/queue.ts already reference 'poison'). customer_impact capped <=0.3 per no-evidence rule."
pm_scope_notes: "Smallest deliverable: purge + forensics dump + --json count, exactly as scoped - nothing to cut further, it is already minimal. No overlap: extends existing src/cli/queue.ts poison handling (11 files already reference 'poison': job-repo.ts, worker.ts, failure-classifier.ts, etc.) rather than duplicating it. AC quality: concrete, testable, includes no-op-safe case. Elevated to P1 despite modest composite_score (0.55) because effort/risk are both near-zero (operator-flagged cheapest win, roadmap's designated 1st-activation item) - ROI justifies priority above raw composite ranking. No cost analog (crew/cost dir absent); no grade history (grades dir has only template)."
pm_risks:
  - "Pre-mortem (P1-mandatory): most likely failure cause is the forensics dump path colliding with an existing dump/export location or missing directory, causing a silent write failure rather than the purge itself failing."
  - "Rollback: revert-only. Purely additive CLI subcommand touching existing queue/job-repo code paths; git revert removes it cleanly, no data migration involved."
  - "Coverage gap: existing queue tests (if any) likely do not cover the zero-poison-jobs no-op path or that purge leaves healthy/pending jobs untouched - AC must add both cases explicitly."
reasoning: "Trivial, safe, cheapest win per roadmap; technical_risk band 0.0-0.2 (known repo pattern extending existing poison-job handling, 1-2 files, clean revert) - P1 on ROI grounds despite modest composite_score."
---
# FEAT-405: `queue purge --poison` CLI (W4.5)

## Description

Manual poison-job purge ahead of the 30-day auto-purge, with a forensics dump
before delete. Operator tool for clearing stuck poison jobs on demand.

## Acceptance criteria (Given / When / Then)

**AC-1** Given N poison-marked jobs, When `queue purge --poison` runs, Then all N are removed AND a forensics dump (job payload + failure reason per job) is written before any deletion.
**AC-2** Given `--json`, When purge runs, Then stdout is `{purged: N, dumpPath: "<path>"}` and nothing else.
**AC-3** Given zero poison jobs, When purge runs, Then it exits 0 with `purged: 0`, writes no dump file, and mutates no rows (no-op safe).
**AC-4** Given healthy and pending jobs alongside poison jobs, When purge runs, Then only poison jobs are removed and healthy/pending counts are unchanged (asserted before/after).
**AC-5** Given the dump target directory does not exist, When purge runs, Then it is created (or the run fails loud) rather than silently dropping the forensics dump.

## Notes

Roadmap W4.5. Complexity: Trivial. Est 1–2h. Cheapest win — suggested activation
order: 1st.
