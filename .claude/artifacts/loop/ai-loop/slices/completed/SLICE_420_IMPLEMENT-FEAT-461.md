---
id: SLICE-420
title: Implement FEAT-461
status: completed
feature: FEAT-461
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-10
updated: 2026-07-10
completed_at: 2026-07-10
---
# SLICE-420: Implement FEAT-461

Implements FEAT-461. See [feature file](../../../backlog/in-progress/FEAT-461.md) for product context.

## Objective

**configToYaml() silently drops newer Config fields on every writeConfig()** —

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] **AC-1 (exhaustive round-trip fidelity).** Given a fully-populated `Config` object
- [ ] **AC-2 (regression guard, not a fixed field list).** Given a new field is added to
- [ ] **AC-3 (observability on incomplete emit).** Given `configToYaml(cfg)` is about to
- [ ] **AC-4 (defaulted-undefined sub-block).** Given an optional sub-block is `undefined`
- [ ] **AC-5 (no behavior change for existing valid configs).** Given a `Config` object

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-461 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
