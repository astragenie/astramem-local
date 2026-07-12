---
id: SLICE-424
title: Implement FEAT-475
status: pending
feature: FEAT-475
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-12
updated: 2026-07-12
tags: ["stack:typescript", "surface:ci"]
---
# SLICE-424: Implement FEAT-475

Implements FEAT-475. See [feature file](../../../backlog/in-progress/FEAT-475.md) for product context.

## Objective

**Eval detach/daemon-manifest tests flake under parallel load** — sibling of

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] **AC-1 — Root cause, not a bandage.**
- [ ] **AC-2 — Full scope covered, not just the original pair.**
- [ ] **AC-3 — Evidence bar: 5 consecutive green full-suite runs under load.**
- [ ] **AC-4 — FEAT-471's fix stays untouched.**
- [ ] **AC-5 — No image-name process kills.**
- [ ] **AC-6 — Product source stays out of scope unless a real bug is proven.**

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-475 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
