---
feature: FEAT-419
status: active
---
# Run Brief: FEAT419 SLICE413: Concurrency tests — parallel ingest + Idempotency-Key race

- Created: 2026-07-04T12:44:26.920Z
- Tier: full
- Goal: Prove or refute the claim→finalize await-window races in the ingest idempotency path with DETERMINISTIC concurrency tests (latch-controlled interleaving, zero sleeps), and fix in the same slice exactly what turns red.
- Mode: autonomous
- Pace: unattended
- Owner: loop
- Status: active
- Summary: -
- Scope:
  - - tests/server/ingest-concurrency.test.ts (new): real Fastify listen on an
  ephemeral port (inject() serializes — useless for concurrency); gated mock
  embed/distill so the mid-window interleaving is FORCED. Scenarios:
  (a) k=5 identical body+key Promise.all → exactly 1 distill enqueue
  - k
  byte-identical response bodies
  - memory count == single fixture yield;
  (b) N=10 distinct keys/bodies → all accepted
  - all distilled within bounded
  poll (queue-drain check
  - no sleeps)
  - none stuck;
  (c) same key + different bodies concurrent → exactly one winner
  - one
  409-class outcome
  - no partial write.
- IF (and only if) a scenario is red: minimal fix inside
  claimIdempotencySlot/finalizeIdempotencySlot (src/server/routes/ingest.ts
  - src/storage/ingest-idempotency.ts). Expected shapes per plan:
- Out Of Scope:
  - - Queue/backpressure redesign — if a fix needs cross-request coordination
  beyond the two helpers
  - STOP and surface to the parent loop (becomes its
  own FEAT).
- Any wire-shape change to POST /ingest/transcript.
- Planned Files: -
- Next Step: Begin implementation

