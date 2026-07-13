---
id: SLICE-434
title: Conversational profile + few-shots + redaction-posture disclosure
status: pending
feature: FEAT-479
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-13
updated: 2026-07-13
effort_points: 2
estimated_tokens: 100000
---
# SLICE-434: Conversational profile + few-shots + redaction-posture disclosure

Implements FEAT-479. See [feature file](../../../backlog/in-progress/FEAT-479.md) for product context.

## Objective

**Memories should be self-contained explanations, not trivia.**

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-9: Given `distill.extractProfile` is `conversational`, When extraction runs on conversational content, Then output follows mem0-pattern liberal extraction (15-80 word self-contained sentences, pronouns resolved, proper nouns preserved, relative dates grounded to an explicit observation date) plus Graphiti-pattern possessor qualification and a banned-abstractions negative list.
- [ ] AC-10: Given the conversational profile's premise is extracting personal-but-not-secret content, When this slice ships, Then the operator-confirmed posture ships as secret-only redaction (`src/redact/index.ts`, unchanged) with an explicit wizard/docs disclosure line stating non-secret personal content is not redacted — not a silent inheritance of the engineering profile's narrower threat model.

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
