---
id: FEAT-419
status: triaged
priority: P1
created: 2026-07-04
updated: 2026-07-04
depends_on: []
slices: []
derived_from: test-inventory-2026-07-04
pm_customer_impact: 0.70
pm_effort_estimate: 0.55
pm_strategic_alignment: 0.60
pm_technical_risk: 0.65
pm_dependency_depth: 0.30
pm_effort_points: 5
composite_score: 0.63
composite_priority: P1
autonomous_safe: false
pm_demand_evidence: "Code-reading finding, not yet a confirmed incident: the check-then-insert idempotency lookup plus async distill enqueue leaves a plausible race window for concurrent identical Idempotency-Key requests; grep confirms zero existing test exercises Promise.all against /ingest across the 121-file suite."
pm_scope_notes: "Scope includes the fix if a race is confirmed (transactional insert-or-replay) — do not split test-authorship from the fix into separate slices; shipping a known race with a disabled red test instead of a fix defeats the purpose."
pm_risks:
  - "If the race is real, the fix touches the core ingest/idempotency path used by every request — needs careful transactional design, not a quick patch."
  - "Concurrency tests are inherently flaky to write well; timing-dependent assertions must use deterministic sync points (mock provider callbacks), not sleeps."
  - "The N-distinct-ingest burst test could surface a separate backpressure/queue design gap that is itself a larger followup, not fixable inside this slice."
reasoning: "Highest-signal FEAT in this batch: this is not just a coverage gap, it is a plausible real bug (duplicate memories, or a 500 where a 200 replay is expected) in a path every ingest request goes through. autonomous_safe=false because a confirmed race very likely requires a production code fix to ship in the same slice, not just new tests."
---
# FEAT-419: Concurrency tests — parallel ingest + Idempotency-Key race

## Problem
Idempotency is enforced via ingest_idempotency table (SHA-256 body hash), but no test fires the SAME Idempotency-Key concurrently. better-sqlite3 is synchronous per connection, yet the check-then-insert flow around idempotency + the async distill enqueue leaves a race window: two in-flight identical requests could both pass the lookup, double-enqueue distill, and produce duplicate memories — or one could 500 on the unique-constraint insert instead of replaying 200. Also untested: N parallel DISTINCT ingests (queue/backpressure behavior under burst).

## Proposal
Integration test (mock providers): (a) fire k identical POST /ingest/transcript with same Idempotency-Key via Promise.all against a live daemon; assert exactly one distill job, all responses 200 with consistent body, memory count == 1x fixture yield. (b) fire N distinct ingests concurrently; assert all accepted, all distilled, no job stuck. (c) same-key different-body concurrent -> exactly one 409 class outcome, no partial write.

## Acceptance (PM GWT)
1. Given k=5 concurrent POST /ingest/transcript requests share the same Idempotency-Key and identical body, When they are fired via Promise.all against a live daemon, Then exactly one distill job is enqueued, all k responses are byte-identical, and memory count equals a single fixture yield.
2. Given N concurrent POST /ingest/transcript requests use N distinct Idempotency-Keys and distinct bodies, When fired concurrently, Then all N are accepted, all reach a completed distill state within a bounded timeout, and no job is left stuck or poisoned.
3. Given two concurrent requests share the same Idempotency-Key but have different bodies, When both are in flight simultaneously, Then exactly one 409-class outcome results and no partial or duplicate write occurs.
4. Given the test suite uncovers a real check-then-insert race, When the slice is scoped, Then a transactional insert-or-replay fix lands in the same slice as the test, not as a follow-up FEAT.
5. Given the fix (if needed) changes the idempotency insert path, When the existing sequential idempotency test runs, Then it remains green (no regression on the already-covered single-request replay case).

## Evidence
Test-inventory review 2026-07-04. ingest-e2e.test.ts covers sequential idempotency replay only; no test in the 121-file suite uses concurrent same-key requests (grep: no Promise.all around /ingest).
