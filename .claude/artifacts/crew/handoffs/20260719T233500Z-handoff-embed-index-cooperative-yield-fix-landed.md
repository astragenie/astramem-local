# Task Handoff: embed-index cooperative-yield fix (event-loop-stall) — landed

- Created: 2026-07-19T23:35:00.000Z
- From: fullstack-dev
- To: dispatcher
- Objective: Fix the production watchdog restart storm caused by `embedAndIndex()` (src/distill/stages/08-embed-index.ts) running a whole distill batch's Phase A/Phase C atom loops fully synchronously with zero cooperative yields.
- Allowed Scope:
  - Add setImmediate-based cooperative yields to embedAndIndex's Phase A and Phase C loops, mirroring ADR-019 Tier 1 (src/consolidate/consolidate.ts).
  - Tertiary: switch serve.ts's hourly wal_checkpoint from TRUNCATE to PASSIVE if safe.
- Forbidden Scope: contradictionDetection batching, embed provider/vec schema/distill logic changes, image-name process kills, git stash.
- Deliverable: Committed fix + 3 new tests on branch fix/embed-index-cooperative-yield (commit 3f66398). No PR opened yet (not requested; branch not pushed).
- Changed Files:
  - src/distill/stages/08-embed-index.ts
  - src/cli/serve.ts
  - tests/distill/08-embed-index.test.ts
- Confidence: high
- Risks: Magnitude of the fix at 54k-row production scale is not independently re-measured post-fix (the original investigation was static/log-gap analysis, not a profiler run) — recommend a live/soak observation of watchdog restart frequency after this ships. yieldEveryNAtoms=25 is a starting default, not empirically tuned against real batch costs; may need adjustment once observed in production.
- Suggested Next Handoff: crew:reviewer for independent review, then crew:validator/deployer for a live soak check that the watchdog restart storm actually stops on the 54k-row store. Consider wiring `yieldEveryNAtoms` through Config (mirroring how consolidate's yieldEveryNPairs currently is NOT config-driven either — parity, not a regression) if production tuning is ever needed.

## Implementation detail (for the reviewer)

- Phase A (erasure/durability/evidence gate) loop and Phase C (insert transaction + entity/relation/vec write) loop each got their own yield counter, both driven by one shared `yieldEveryNAtoms` (ctx-overridable, default 25 — smaller than consolidate.ts's 200 because each atom here does substantially more DB work: an insert transaction + N entity upserts + relation inserts + vec upsert, not just a cosine compare).
- Yield check placed at the TOP of each loop iteration, counted before any `continue`/early-exit (mirrors consolidate.ts's `processPair` counter posture: "counted regardless of early returns").
- Transaction-boundary reasoning: `MemoryRepo.insertWithCreateEvent` (src/storage/memories.ts:176) wraps its OWN single-atom `db.transaction()` — verified this is not a whole-batch transaction. The entity (`EntityRepo.upsert`/`linkWithValidity`) and relation (`EntityRelationRepo.insert`) writes that follow in the same iteration are plain prepared-statement calls, never wrapped in a transaction spanning more than one atom. So a yield landing at the next iteration's top always falls strictly BETWEEN one atom's fully-committed work and the next atom's — never mid-transaction.
- `wal_checkpoint`: two call sites existed (hourly periodic timer, and once at graceful shutdown). Only the periodic one was switched to PASSIVE — the shutdown one is intentionally left as TRUNCATE since shutdown has no live `/health` traffic to protect and a full blocking truncate there minimizes the WAL file left on disk.
- Tests added (tests/distill/08-embed-index.test.ts, new describe block before the FEAT-533 atom-triage describe): (1) yield hook fires the expected count across both phases for a 12-atom/interval-5 batch, (2) no yield fires when batch < default interval, (3) interval=1 vs default interval produce byte-identical insert outcomes (behavior-preserving).

## Verification evidence

- `bunx vitest run tests/distill/08-embed-index.test.ts` — 51 passed (51), including the 3 new tests.
- `bunx vitest run tests/distill tests/storage tests/vector` — 55 files, 1035 tests passed.
- `bunx vitest run tests/consolidate` — 124 passed, 3 skipped (sanity check on the mirrored pattern's own file, untouched).
- `bunx tsc --noEmit -p .` — clean.
- `bunx tsc --noEmit -p tsconfig.eval.json` — clean.
- `bunx tsc -p tsconfig.tests.json --noEmit` — clean.
