# Handoff: feedbackLoopSummary 8-scan wedge — release gate, fix implemented, PR open

**Objective:** Fix a release-gating live-daemon-wedge risk — `feedbackLoopSummary()` (doctor's "Usefulness feedback loop" full-tier canary, `src/storage/usefulness.ts`) ran eight separate unindexed-in-practice `COUNT(DISTINCT atom_id)` scans of `memory_events`, measured at ~22.5s as one continuous synchronous block on live data — longer than the watchdog's kill threshold (`DEFAULT_PROBE_TIMEOUT_MS` × 2 consecutive failures), plausibly contributing to the "healthy daemon killed" incident class chased all day on 2026-08-02.

**Owner:** builder (this session), worktree `C:\work\mega\wt-feedbackloop`, branch `fix/feedback-loop-summary-scans`, forked from `origin/main` tip `173a4327` (includes PR #470's vec-join fix).

**Allowed scope:** `feedbackLoopSummary()` and a new partial index for the one family migration 019 never covered (`memory_corrected`).

**Forbidden scope (honored):** did not touch `buildMemoryHealthFull` (documented intentional full-tier-only tradeoff), doctor's cheap-tier aggregate, or any doctor tier reassignment (`memory-health` stays `tier: 'full'`, hard-locked by `FULL_TIER_ONLY_CHECK_NAMES` in `tests/doctor/schedule.test.ts`).

**Deliverable:** [PR #472](https://github.com/astragenie/astramem-local/pull/472) (draft), branch pushed to origin.

## What changed

- `src/storage/usefulness.ts`: `feedbackLoopSummary()` rewritten from 8 queries to 3 (one per family: `recall_served`, `recall_used`, `memory_corrected`), each family's sub-buckets (signal/source/the `correctedUnknown` anti-join) computed from a single read of that family's rows in JS instead of one query per sub-bucket.
- `migrations/063-usefulness-feedback-loop-index.sql`: new partial index `idx_memory_events_usefulness_corrected` on `memory_events(atom_id) WHERE event_type='usefulness' AND family='memory_corrected'` — scoped to exactly the one family with no prior coverage, disjoint from migration 019's two existing indexes.
- `tests/storage/usefulness.test.ts`: new equivalence suite — a preserved copy of the old 8-query logic as a test-only oracle, asserted byte-identical to the new implementation across 9 fixtures including the trickiest edge case (an atom with both a sourced and unsourced correction must NOT count as "unknown" — preserves the original `NOT IN` subquery's anti-join semantics exactly).
- `tests/storage/migrate.test.ts`: migration 063 tests (index presence, actually-serves-the-query, idempotency, and an explicit non-regression lock).

## A rejected design, kept in the PR body and code comments for the record

First draft: one query covering all three families behind one new broad index (`WHERE event_type='usefulness'` alone). Fast in isolation, but measurably regressed `usefulnessRate()`'s own unrelated query ~40x (1ms → 44ms) because SQLite's planner started preferring the new broad index over migration 019's for that query too. Reverted. Final design scopes the new index to exactly `family='memory_corrected'` so it can never compete with anything else's plan — locked in by a dedicated non-regression test.

## Measurements (see PR body for the full before/after table)

- 145k-row DB via real `migrate()`: 241ms → 110ms, byte-identical result, all three sub-queries hit their intended dedicated index.
- Live encrypted prod DB, read-only (`openProductionDbReadonly`, never a writer — migration 063 not applied there since reads never migrate): 22,023ms → 355ms, byte-identical result on real production data — a 62x win from the query-count reduction alone, before the new index's benefit even applies.
- AC met with margin: every measurement well under the 500ms/1s bar.

## Load-contamination status

Box was under heavy concurrent load (~100% CPU, many node/bun processes) for parts of this session, per the team lead's explicit warning. The old-implementation live number (22,023ms) is consistent with an earlier, separately-measured ~22.5s figure taken before the heaviest contention, so it isn't primarily a load artifact. New-implementation live numbers (352-389ms across 4 runs) are low-variance. The query-plan evidence (which index gets chosen) is load-independent by construction and is what the fix design actually rests on, not the absolute ms.

## Test evidence

Full suite: 417 files, 5666 passed, 19 skipped, 0 failures. `bun run build` clean throughout.

## Confidence level

High on correctness (equivalence proven on both synthetic and real production data, not just unit fixtures) and on the fix's algorithmic soundness (query-plan evidence, not just timing). Medium-high on "this fully resolves the watchdog-kill incident" — that requires deployment and live confirmation; this session did not touch the running daemon or deploy anything (out of scope per dispatch), and migration 063 has not been applied anywhere outside the synthetic test DB.

## Risks / open questions

- The live-DB "after" number (355ms) does not yet reflect migration 063's index benefit, since the live DB was never migrated (correctly — read-only throughout). Expect the live number to drop further, toward the ~110ms synthetic figure, once 063 is actually applied via a real deploy.
- `correctedUnknownDistinct`'s anti-join semantics are the one genuinely tricky piece of this rewrite — thoroughly covered by a dedicated test, but worth a reviewer's extra attention given it's the one bucket that can't be computed by simple per-row classification alone.

## Suggested next handoff

Reviewer → `crew:reviewer` (or `/crew:review`) on PR #472, focusing on: the anti-join equivalence proof, whether the narrow single-family index design is the right long-term shape (vs., e.g., a future covering index), and the load-contamination framing. After review PASS, deployer: ship + apply migration 063 + confirm the live daemon's doctor full-tier pass no longer produces multi-second event-loop stalls, and ideally confirm the watchdog no longer kills a healthy daemon during that pass — this is the step that actually closes the incident this fix targets.
