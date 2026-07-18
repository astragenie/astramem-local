---
id: SLICE-437
title: Implement FEAT-543
status: completed
feature: FEAT-543
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-18
updated: 2026-07-18
completed_at: 2026-07-18
---
# SLICE-437: Implement FEAT-543

Implements FEAT-543. See [feature file](../../../backlog/in-progress/FEAT-543.md) for product context.

## Objective



## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-1: Given >=15 gold-operation fixtures in `tests/eval/consolidation-eval.test.ts`
- [ ] AC-2: Given the same 15-fixture set, When `runConsolidation` is exercised
- [ ] AC-3: Given the full fixture run's actual-vs-gold diff, When the weighted
- [ ] AC-4: Given the current production thresholds (merge 0.92 / propose 0.85),
- [ ] AC-5: Given `tests/eval/consolidation-eval.test.ts` running under the
- [ ] AC-6: Given the optional LLM-judge merged-text-quality pass, When the test
- [ ] AC-7: Given the fixture representing two distinct facts about the same
- [ ] AC-8: Given a completed eval run, When the weighted-error report is

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-543 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
