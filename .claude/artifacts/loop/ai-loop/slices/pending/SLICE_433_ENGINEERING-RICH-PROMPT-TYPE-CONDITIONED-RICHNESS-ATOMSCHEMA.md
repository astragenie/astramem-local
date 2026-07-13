---
id: SLICE-433
title: Engineering-rich prompt + type-conditioned richness + AtomSchema cap bump
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
# SLICE-433: Engineering-rich prompt + type-conditioned richness + AtomSchema cap bump

Implements FEAT-479. See [feature file](../../../backlog/in-progress/FEAT-479.md) for product context.

## Objective

**Memories should be self-contained explanations, not trivia.**

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-5: Given the rewritten engineering-profile prompt, When a `lesson` or `decision` atom is extracted, Then its text carries claim + rationale + tradeoff/consequence + provenance in the 300-800 character range, judged against a held-out set of real sessions by a human or judge — not by length alone, since a long trivia fragment is still trivia.
- [ ] AC-6: Given the same rewritten prompt, When a `fact` or `command` atom is extracted, Then it stays atomic and single-valued, because the prompt states the type-conditioned richness rule as an explicit instruction line (not only implied via few-shot example shape).
- [ ] AC-7: Given `AtomSchema.text` currently caps at `max(500)` (`src/distill/prompts/extract.ts:39`), When this slice lands, Then the cap is bumped to `max(1000)` (TEXT column, no migration) so the 300-800-char target is never silently truncated or schema-rejected.
- [ ] AC-8: Given a memory carries multiple claims and one becomes false, When the supersession question is resolved (design D4, option (a)), Then rich multi-claim shape is permitted only for `lesson`/`decision` types (rarely superseded) while `fact`/`command` stay atomic (frequently superseded), stated explicitly in the prompt and docs, not left implicit.

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
