---
id: SLICE-423
title: Implement FEAT-457
status: pending
feature: FEAT-457
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-10
updated: 2026-07-10
---
# SLICE-423: Implement FEAT-457

Implements FEAT-457. See [feature file](../../../backlog/in-progress/FEAT-457.md) for product context.

## Objective



## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] **AC-1:** Given `scripts/eval/shared/` hosts the daemon-plumbing tier (spawn-daemon,
- [ ] **AC-2:** Given `sample.mts` runs with no prior local copy of the dataset,
- [ ] **AC-3:** Given `run.mts` orchestrates a LoCoMo run, **when** it spawns a daemon
- [ ] **AC-4:** Given `judge.mts`/`judge/metrics.mts` currently score exactly one run
- [ ] **AC-5:** Given `vitest.config.ts` has no path scoping beyond excluding
- [ ] **AC-6:** Given no LoCoMo number has ever been published from this repo,

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-457 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
