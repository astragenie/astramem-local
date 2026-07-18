---
id: SLICE-438
title: Implement FEAT-542
status: completed
feature: FEAT-542
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-18
updated: 2026-07-18
completed_at: 2026-07-18
---
# SLICE-438: Implement FEAT-542

Implements FEAT-542. See [feature file](../../../backlog/in-progress/FEAT-542.md) for product context.

## Objective



## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-1: Given the `fixtures/` directory under `scripts/eval/extraction-bench/`
- [ ] AC-2: Given a new fixture's `forbidden_items` array (e.g. the superseded
- [ ] AC-3: Given an atom carrying a non-empty `evidence` string, When the daemon
- [ ] AC-4: Given the expanded fixture set (43 + >=10 new), When the bench is
- [ ] AC-5: Given the new fixture categories and forbidden_items convention,
- [ ] AC-6: Given a fixture whose `forbidden_items` entry is a SUBSTRING of a
- [ ] AC-7: Given a bench run computing Evidence-acc and forbidden-item hits,

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-542 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
