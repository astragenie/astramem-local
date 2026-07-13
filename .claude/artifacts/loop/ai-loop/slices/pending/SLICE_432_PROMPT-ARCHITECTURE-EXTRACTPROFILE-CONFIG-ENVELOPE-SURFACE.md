---
id: SLICE-432
title: Prompt architecture + extractProfile config/envelope surface
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
# SLICE-432: Prompt architecture + extractProfile config/envelope surface

Implements FEAT-479. See [feature file](../../../backlog/in-progress/FEAT-479.md) for product context.

## Objective

**Memories should be self-contained explanations, not trivia.**

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

> Trimmed from the FEAT-479-level list (17 ACs shared across 6 sibling
> slices) to this slice's actual scope — architecture/plumbing only, not
> prompt content. See "AC scope mapping" below for where the rest live.

- [x] AC-2: Given `config.yaml` sets `distill.extractProfile` to `engineering` or `conversational` (default `engineering`), When a distill run resolves its prompt, Then resolution happens per-run (not at module load), and output is byte-identical to today's behavior when `extractProfile` is `engineering` with no override set.
- [x] AC-3: Given the canonical ingest envelope carries an optional `extract_profile` field, When a per-ingest request supplies it, Then it overrides the config-level default for that request only, added as an additive zod field with no wire-schema break.
- [x] AC-4: Given `ASTRA_EXTRACT_PROMPT` is set, When a distill run resolves its prompt, Then the env var still wins as an override over both the config default and any per-ingest `extract_profile` field, preserving today's override behavior.

### AC scope mapping (full FEAT-479 list, 17 ACs)

- **This slice (SLICE-432):** AC-2, AC-3, AC-4 — config surface, envelope
  surface, per-run prompt resolution + precedence, prompt-registry stub.
- **Out of scope, belongs to prompt-content slices (SLICE-433 engineering-rich,
  SLICE-434 conversational):** AC-5, AC-6, AC-7 (`AtomSchema.text` cap bump —
  tied to the new richer prompt's 300-800ch target, not this slice's plumbing),
  AC-8, AC-9, AC-10.
- **Out of scope, belongs to FEAT-481 (entity relations, dependent ticket):**
  AC-11 (`AtomSchema.relations[]` field).
- **Out of scope, belongs to the proof-phase slice:** AC-12, AC-13, AC-14.
- **Out of scope, belongs to other named slices:** AC-0 (already resolved by
  evidence per the design doc, no work needed), AC-1 (codex-subscription
  empty-SSE hardening — SLICE-431, already completed), AC-15 (doctor
  budget-cap WARN row), AC-16 (CLAUDE.md wording correction, needs operator
  sign-off).

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
