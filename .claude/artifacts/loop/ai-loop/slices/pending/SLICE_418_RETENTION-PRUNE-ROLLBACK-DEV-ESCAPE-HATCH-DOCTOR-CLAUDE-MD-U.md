---
id: SLICE-418
title: "Retention/prune + --rollback + --dev escape hatch + doctor/CLAUDE.md updates (AC-3, AC-4)"
status: pending
feature: FEAT-438
phase: null
priority: P0
target_release: null
requires_validation: true
risk: high
created: 2026-07-07
updated: 2026-07-07
effort_points: 5
---
# SLICE-418: Retention/prune + --rollback + --dev escape hatch + doctor/CLAUDE.md updates (AC-3, AC-4)

Implements FEAT-438. See [feature file](../../../backlog/in-progress/FEAT-438.md) for product context.

## Objective

`current.json.entryJs` points at `C:/work/mega/astramemory-local/dist/cli/index.js`

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-1: Given `reinstall` runs, When it materializes
- [ ] AC-2: Given the service points at a versioned release directory, When the repo
- [ ] AC-3: Given two consecutive `reinstall` runs have each materialized a new
- [ ] AC-4 (edge case): Given an operator runs `reinstall --dev`, When the shim
- [ ] AC-5 (failure/native-module edge case): Given `bun install --production` into

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-438 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
