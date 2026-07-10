---
id: SLICE-419
title: distiller durability quality gate — stop persisting low-signal atoms at the store layer
status: completed
feature: FEAT-441
phase: null
priority: P1
target_release: null
requires_validation: true
risk: medium
created: 2026-07-09
updated: 2026-07-09
completed_at: 2026-07-09
badges: [serial-reviewer-warning]
---
# SLICE-419: distiller durability quality gate — stop persisting low-signal atoms at the store layer

Implements FEAT-441. See [feature file](../../../backlog/in-progress/FEAT-441.md) for product context.

## Objective

Add a config-gated durability filter at the distill store-write path so
low-signal atoms (ephemeral state, git-derivable trivia, vacuous negatives,
bare todos/commands, path fragments) are skipped before `insertWithCreateEvent`
— the daemon store as the shared "last line of defense" for every producer.
Default **off** (byte-identical to today), observable per job, and never
silently dropping a deliberate `/remember`.

## In scope

- New single-source classifier module `src/distill/durability-gate.ts` — one
  exported classify fn returning `null | gatedReason` over the fixed enum
  `ephemeral_state | git_derivable | vacuous_negative | bare_todo | path_fragment`.
- Wire it at the real persist site `src/distill/stages/08-embed-index.ts:84`
  (`memRepo.insertWithCreateEvent`) as a second `continue`-style filter in the
  same ordering position as the ADR-006 erasure-replay filter at `:80` — NOT in
  `07-memory-normalize.ts`.
- Config knob `distill.durabilityGate: strict | lenient | off`, **default off**;
  read at boot via the existing config path (no hot reload — CLAUDE.md).
- Observability: `gatedOutCount` integer in the distill job's structured log +
  the per-job digest/summary; rejected candidates retained as a **log line only**
  (through the existing Stage-0 `redactIfEnabled` redaction, bounded by the
  `ingest.log` 10MB rotation) — no new side table.
- `doctor` informational row reporting current gate mode.
- ADR-005 eval: new junk-pollution fixture proving gated recall@10 > ungated;
  existing recall@10 ≥ 0.9 / NDCG@10 ≥ 0.7 floors must hold with gate on.
- Tests for classifier + wiring + `/remember` bypass + eval fixture.

## Out of scope

- Structured/side-table retention of rejected candidates (log-line only this
  slice; defer richer store to a fast-follow — re-score if chosen, per PM).
- Any behavior change to `/remember` beyond guaranteeing it is NOT gated
  (`src/server/routes/search.ts:202` already bypasses distill by construction).
- SaaS mirror memory#659 taxonomy sync, plugin bridge astramem-plugin#28, and
  FEAT-437 consolidation-inflow work — downstream, not this slice.
- Changing the default to `lenient`/`strict` — opt-in only until eval'd.
- AC-4 digest-surfacing of gatedOutCount deferred to fast-follow (log-line
  count ships this slice); avoided a schema-version bump per PM triage.

## Acceptance criteria

- [ ] AC-1 (happy path, memory#659 evidence set): Given the memory#659 evidence
- [ ] AC-2 (gate off = byte-identical, safe default): Given
- [ ] AC-3 (ADR-005 eval regression floor + junk-pollution fixture): Given the
- [ ] AC-4 (observability, gated-out count per job): Given a distill job gates
- [ ] AC-5 (edge case — deliberate /remember never silently dropped): Given a
- [ ] AC-6 (architecture — single choke point, no duplicated logic): Given the
- [ ] AC-7 (security — rejected-candidate retention passes through redaction,
- [ ] AC-8 (production readiness — operational visibility of gate mode): Given
- [ ] AC-9 (product completeness — all 5 requested-capability items shipped

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-441 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written
- (pure refactors / mechanical changes: set `requires_validation: false` in frontmatter
   above to waive the validation gate — no badge needed at close time)

## Reviewer ladder

- Reviewer A: ...
- Reviewer B: ...
