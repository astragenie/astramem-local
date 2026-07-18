---
id: SLICE-440
title: Implement FEAT-550
status: pending
feature: FEAT-550
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-18
updated: 2026-07-18
---
# SLICE-440: Implement FEAT-550

Implements FEAT-550. See [feature file](../../../backlog/in-progress/FEAT-550.md) for product context.

## Objective



## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-1: Given `search.queryRewrite.mode: 'off'` (the shipped default), When
- [ ] AC-2: Given the rewrite call throws, times out, or exceeds a hard ~1-2s
- [ ] AC-3: Given the original query and N rewritten variants each produce their
- [ ] AC-4: Given the LoCoMo `--diagnose` harness (existing tooling), When an
- [ ] AC-5: Given `mode: 'enabled'` but no rewrite variants clear a minimum

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-550 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
