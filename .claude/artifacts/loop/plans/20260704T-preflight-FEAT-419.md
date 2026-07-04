# Preflight plan — FEAT-419: Concurrency tests, parallel ingest + Idempotency-Key race

status: awaiting-user-approval
prepared: 2026-07-04 (second orchestrator session)
slice shape: ONE slice (test + fix together, per pm_scope_notes)

## Code findings (read-only investigation)

- `src/server/routes/ingest.ts` uses insert-first claiming, NOT naive
  check-then-insert: `claimIdempotencySlot()` (line ~212) synchronously
  INSERTs a `__pending__` placeholder, then SELECTs and branches on
  body_hash / pending state. better-sqlite3 is sync, Node single-threaded →
  the claim itself is atomic within one event-loop tick.
- REAL suspect window: between claim and `finalizeIdempotencySlot()` (line
  ~331) the handler awaits (transcript insert / enqueue). A concurrent
  same-key request that lands mid-window hits the `__pending__` row. Two
  candidate bugs:
  1. Replay response built from placeholder state → responses not
     byte-identical across the k requests (AC-1 violation).
  2. The stale-pending takeover branch (delete + reinsert, lines ~228-229)
     may let request B steal A's in-flight slot → double distill enqueue.
- Distinct-key burst path (AC-2) exercises the job queue — no known bug,
  pure coverage.

## Plan

1. **Red tests first** (`tests/server/ingest-concurrency.test.ts`, live
   Fastify listen — inject() serializes, concurrency needs real sockets):
   - k=5 identical body+key via Promise.all → assert 1 distill job, k
     byte-identical bodies, memory count == 1 fixture yield.
   - N=10 distinct keys/bodies → all 200, all distilled within bounded
     timeout (poll job/queue state, NO sleeps — deterministic sync via mock
     provider + queue drain check).
   - same key, different bodies concurrent → exactly one winner, one
     409-class outcome, no partial write.
   - Determinism: mock embed provider with a gate/latch (controllable
     resolve) so the mid-window interleaving is FORCED, not timing-hoped.
2. **Fix only what red tests prove** (expected shape, if confirmed):
   - Replay-during-pending: respond with the same transcript id the winner
     will finalize (placeholder already stores key→`__pending__`; store the
     transcript id at claim time instead of finalize, or block replay
     response on a per-key in-process promise).
   - Slot-steal: takeover branch must distinguish crashed-stale (old
     created_at) from in-flight (fresh) — only steal stale.
   - Keep the fix inside claim/finalize helpers; no route-shape changes,
     no queue redesign (explicit FEAT risk: backpressure gaps become a
     follow-up FEAT, not scope creep here).
3. Existing sequential idempotency tests must stay green (AC-5).

## touches_files

- tests/server/ingest-concurrency.test.ts (new)
- src/server/routes/ingest.ts (only if red)
- src/storage/ingest-idempotency.ts (only if red)

## Risks

- Flaky-test risk mitigated by latch-based interleaving control; if a
  scenario cannot be made deterministic it gets dropped with a written
  reason, not committed flaky.
- If the fix requires cross-request coordination beyond the two helpers
  (e.g. queue dedup), STOP and escalate — that's the backpressure follow-up.

## Estimate

5 pts. One builder dispatch, review + validation gates as usual.
