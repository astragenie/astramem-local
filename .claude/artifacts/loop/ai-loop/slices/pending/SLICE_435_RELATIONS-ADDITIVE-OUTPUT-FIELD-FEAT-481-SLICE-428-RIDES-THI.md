---
id: SLICE-435
title: "Relations[] additive output field (FEAT-481 SLICE-428 rides this)"
status: pending
feature: FEAT-479
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-13
updated: 2026-07-13
effort_points: 1
estimated_tokens: 60000
---
# SLICE-435: Relations[] additive output field (FEAT-481 SLICE-428 rides this)

Implements FEAT-479. See [feature file](../../../backlog/in-progress/FEAT-479.md) for product context.

## Objective

**Memories should be self-contained explanations, not trivia.**

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-11: Given FEAT-481's entity-relations design, When the shared `AtomSchema` is extended, Then an optional `relations[]` field is added nested inside each atom, each entry validated against a closed lowercase snake_case predicate enum (10 values + `other`) with a same-atom no-hallucination guard (subject/object must appear in that atom's own `entities[]` list) — matching FEAT-481 SLICE-428's AC-6/AC-7 exactly, since this is the shared-schema half of that dependent slice.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-479 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
