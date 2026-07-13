---
id: SLICE-436
title: "Hardened proof phase (blinded, ranges, cost/latency) + budget-cap doctor WARN"
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
# SLICE-436: Hardened proof phase (blinded, ranges, cost/latency) + budget-cap doctor WARN

Implements FEAT-479. See [feature file](../../../backlog/in-progress/FEAT-479.md) for product context.

## Objective

**Memories should be self-contained explanations, not trivia.**

## In scope

- bullet 1
- bullet 2

## Out of scope

- bullet 1

## Acceptance criteria

- [ ] AC-12: Given the proof phase runs, When it executes, Then it covers >=2 runs per config across 4 configs (qwen/old-prompt baseline, qwen/new-prompt, codex-mini/new-prompt, codex-5.5/new-prompt), reports a range per config (not a single point estimate), and the eyeball judging pass is blinded (config labels hidden until after judging).
- [ ] AC-13: Given the proof-phase report, When it is published, Then it includes a cost and latency column per config alongside the quality/MRR numbers.
- [ ] AC-14: Given the new engineering-rich prompt lands, When `scripts/eval/recall-quality/run.mjs` runs, Then plain-English MRR stays at or above the post-RECALL-S1 baseline — the guard that stops richer memories from becoming unfindable ones.
- [ ] AC-15: Given codex-subscription always reports `usage.usd: 0` (subscription quota has no per-token price), When a daily LLM budget cap is configured, Then doctor emits a WARN row stating the budget cap does not apply under this provider.
- [ ] AC-16: Given AC-0's measured resolution, When this FEAT lands, Then `CLAUDE.md`'s "write memories SHORT" rule is corrected to reflect it (long memories retrieve fine up to ~700 chars tested; the ~1,500-2,000-char caution is labeled untested, not asserted as fact) — proposed as wording for operator sign-off, not silently rewritten.

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
