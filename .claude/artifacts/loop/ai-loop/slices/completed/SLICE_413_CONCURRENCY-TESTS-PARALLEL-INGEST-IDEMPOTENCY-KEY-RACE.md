---
id: SLICE-413
title: Concurrency tests — parallel ingest + Idempotency-Key race
status: completed
feature: FEAT-419
phase: null
priority: P1
target_release: null
requires_validation: true
risk: high
created: 2026-07-04
updated: 2026-07-04
touches_files: [tests/server/ingest-concurrency.test.ts, src/server/routes/ingest.ts, src/storage/ingest-idempotency.ts]
completed_at: 2026-07-04
---
# SLICE-413: Concurrency tests — parallel ingest + Idempotency-Key race

Implements FEAT-419 per the user-approved preflight plan
`.claude/artifacts/loop/plans/20260704T-preflight-FEAT-419.md` (READ IT FIRST —
it contains the code findings and the two concrete race suspects).

## Objective

Prove or refute the claim→finalize await-window races in the ingest
idempotency path with DETERMINISTIC concurrency tests (latch-controlled
interleaving, zero sleeps), and fix in the same slice exactly what turns red.

## In scope

- tests/server/ingest-concurrency.test.ts (new): real Fastify listen on an
  ephemeral port (inject() serializes — useless for concurrency); gated mock
  embed/distill so the mid-window interleaving is FORCED. Scenarios:
  (a) k=5 identical body+key Promise.all → exactly 1 distill enqueue, k
  byte-identical response bodies, memory count == single fixture yield;
  (b) N=10 distinct keys/bodies → all accepted, all distilled within bounded
  poll (queue-drain check, no sleeps), none stuck;
  (c) same key + different bodies concurrent → exactly one winner, one
  409-class outcome, no partial write.
- IF (and only if) a scenario is red: minimal fix inside
  claimIdempotencySlot/finalizeIdempotencySlot (src/server/routes/ingest.ts,
  src/storage/ingest-idempotency.ts). Expected shapes per plan: replay must
  return the winner's transcript id (never `__pending__`); stale-pending
  takeover must distinguish crashed-stale (old created_at) from in-flight.
- Existing sequential idempotency tests stay green.

## Out of scope

- Queue/backpressure redesign — if a fix needs cross-request coordination
  beyond the two helpers, STOP and surface to the parent loop (becomes its
  own FEAT).
- Any wire-shape change to POST /ingest/transcript.

## Acceptance criteria

- [ ] AC-1: Given k=5 concurrent POST /ingest/transcript with the same
      Idempotency-Key and identical body fired via Promise.all against a live
      daemon, when all settle, then exactly one distill job was enqueued, all
      k bodies are byte-identical, and memory count equals one fixture yield.
- [ ] AC-2: Given N=10 concurrent ingests with distinct keys and bodies, when
      fired concurrently, then all are accepted and reach completed distill
      state within a bounded deterministic wait; no job stuck or poisoned.
- [ ] AC-3: Given two concurrent requests sharing a key with different bodies,
      when both are in flight simultaneously (latch-forced), then exactly one
      409-class outcome results and no partial or duplicate write occurs.
- [ ] AC-4: Given any scenario turned red, when the slice completes, then the
      transactional insert-or-replay fix landed in THIS slice and the red test
      is green — no disabled/skipped red tests committed.
- [ ] AC-5: All tests pass (`bunx vitest run`) and typecheck clean
      (`bun run build`); existing sequential idempotency replay tests
      unmodified and green.

## Done When

- all ACs PASS with evidence per `01-loop-control/EVIDENCE_RULES.md`
- feature FEAT-419 moved from `in-progress/` to `done/`
- Crew `final-synthesis` artifact written

## Reviewer ladder

- Reviewer A: crew:reviewer (correctness/regressions)
- Reviewer B: crew:typescript-reviewer (only if Reviewer A flags depth)
