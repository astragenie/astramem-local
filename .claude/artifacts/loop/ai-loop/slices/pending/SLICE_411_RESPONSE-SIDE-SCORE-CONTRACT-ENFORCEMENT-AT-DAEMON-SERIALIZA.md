---
id: SLICE-411
title: Response-side score contract enforcement at daemon serialization boundary
status: pending
feature: FEAT-413
phase: null
priority: P2
target_release: null
requires_validation: true
risk: medium
created: 2026-07-04
updated: 2026-07-04
touches_files:
  - src/server/lib/score-contract.ts
  - src/server/routes/search.ts
  - src/server/routes/recall.ts
  - tests/server/score-contract.test.ts
---
# SLICE-411: Response-side score contract enforcement at daemon serialization boundary

Implements FEAT-413. See [feature file](../../../backlog/in-progress/FEAT-413.md) for product context.

## Objective

Enforce the [0,1] score wire contract at the daemon's response serialization
boundary, independent of fuseScores() internal math. Any future path that
constructs a hit score outside fuseScores (second fusion strategy, manual
override, stale cache) must be clamped and logged server-side instead of
shipping invalid wire data that only the plugin's client-side Zod rejects
(the cedc8a9 failure mode: plugin exit 3, daemon oblivious).

## In scope

- One small shared helper (e.g. `clampScore(value, ctx)`) that clamps a score
  into [0,1], maps non-finite values (NaN/Infinity) to a safe bound, and emits
  a structured pino warning with route + memory id context when it fires.
- Apply it exactly where search/recall hits serialize to JSON:
  `src/server/routes/search.ts` (both response sites) and
  `src/server/routes/recall.ts` (memories score site).
- Tests: hand-crafted out-of-contract scores (>1, <0, NaN) pushed through the
  serialization path → response carries clamped values, warning logged,
  status stays 200.

## Out of scope

- Any general response-validation framework or schema middleware (explicit
  pm_scope_notes guard).
- Changes to fuseScores() or search ranking math.
- Plugin/SaaS-side changes.

## Acceptance criteria

- [ ] AC-1: All tests pass (`bun run test`) and typecheck is clean (`bun run build`)
- [ ] AC-2: Given a hit whose score is above 1 (or below 0) at the search/recall
      serialization boundary, when the response is serialized, then the wire
      value is clamped into [0,1] and a server-side warning with route and hit
      id is logged — verified by a unit/integration test that injects an
      out-of-contract score without going through fuseScores.
- [ ] AC-3: Given a non-finite score (NaN), when serialized, then the wire value
      is a finite number inside [0,1] (0), a warning is logged, and the request
      still returns 200 — verified by test.
- [ ] AC-4: Given normal in-contract scores, when serialized, then values pass
      through bit-identical and NO warning is logged (no noise on the happy
      path) — verified by test.

## Done When

- all acceptance criteria PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- build / test commands per `.claude/loop.json` pass
- feature FEAT-413 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written

## Reviewer ladder

- Reviewer A: crew:reviewer (correctness/regressions)
- Reviewer B: crew:typescript-reviewer (stack idiom, only if Reviewer A flags depth)
