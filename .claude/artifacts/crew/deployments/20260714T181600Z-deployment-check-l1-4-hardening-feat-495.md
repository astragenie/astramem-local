---
task: L1-4 (wave merge, follows L1-3)
repo: astramemory-local
date: 2026-07-14
operator_approval: on record — merge review-PASS wave lanes, same bounds as SYNC-1/L1-3
bounds: no force-push, no tags, stop on red
outcome: PASS — merged clean after diagnosing one CI flake and one real migration-numbering race
related: .claude/artifacts/crew/deployments/20260714T173700Z-deployment-check-l1-3-retention-feat-493.md
---

# Deployment check — L1-4 hardening bundle (FEAT-495)

## PR

[#322](https://github.com/astragenie/astramem-local/pull/322) — "feat(hardening): FEAT-495 —
json-guard for sync poison batches, migration self-heal, handler run-log, seams sweep".
`wave/l1-4-hardening` → `main`. 6 original commits (`f06451d`, `4a28d7a`, `dc1e4be`, `e0b394e`,
`f944e74`, `ff422b4`) + 1 merge-resolution commit (`c1e1c7c`).

## Review on record

PASS (after fix cycle) —
`.claude/artifacts/crew/reviews/20260714T174617Z-review-l1-4-hardening-feat-495.md`. Original pass
found two required fixes on item 1 (the poison-batch json-guard): an overstated "regardless of
event_type" claim in the migration/guard header comments, and a missing E2E test through the real
`pullOnce()` path. Both closed by `ff422b4`, independently re-verified by the reviewer including
re-running their own standalone `better-sqlite3` repro script. 833/833 tests, both tsc configs
clean at review time.

## Priority instruction from team-lead

Merge L1-4 before any L1-1/L1-2 PR arrives, since this lane claims migration numbers 044-046 and
the still-building lanes were told to take the next free number after checking live main. Executed
as the very next merge job after the ADR-017 flip (#321).

## Migration-numbering race: happened anyway, caught and fixed

The review confirmed 044-046 free *at review time*. By the time this PR was ready to open, three
more PRs had landed on `main` since the branch forked, one of which — `1ee22b6` (#318,
"feat(security+distill): redaction pattern port... judge near-threshold instrumentation") — **also
claimed migration number 044** (`044-consolidation-judge-near-threshold.sql`), for reasons
unrelated to L1-1/L1-2 (a separate, already-in-flight lane, not one of the two the team-lead's
priority note was guarding against). So the race happened despite landing L1-4 as the very next
job — just from a different direction than anticipated.

**Resolved by renumbering this lane's three new migrations**, since the collision was caught before
merge, not after:
- `044-guard-usefulness-partial-indexes.sql` → `045-guard-usefulness-partial-indexes.sql`
- `045-migration-self-heal-log.sql` → `046-migration-self-heal-log.sql`
- `046-handler-run-log.sql` → `047-handler-run-log.sql`

Version is derived purely from the filename prefix (`src/storage/migrate.ts`), so the rename is a
complete fix. Updated every self-referential header comment and every cross-file doc-comment
reference (`src/storage/json-guard.ts`, `src/doctor/checks/migration-self-heal.ts`,
`src/doctor/checks/handler-run-log.ts`, and four test files:
`tests/doctor/migration-self-heal-check.test.ts`, `tests/doctor/handler-run-log-check.test.ts`,
`tests/storage/migrate.test.ts` ×3, `tests/sync/puller.test.ts`) — verified via `grep` before and
after that no stale reference remained, and that `src/storage/consolidation-judge-log.ts`'s own
`migration 044` reference (the *other* lane's migration) was correctly left untouched.

## doctor/checks/index.ts conflict: resolved as flagged

Same-anchor conflict against merged L1-3 (`checkRetention`, #317) as the team-lead predicted.
Resolved by keeping all registrations — `checkMigrationSelfHeal`, `checkHandlerRunLog`,
`checkRetention` all coexist, additive, no interaction.

## Local verification before push

Rebuilt `dist/` post-merge first (lesson carried from L1-3: CLI-spawning tests need the built
output, not source).

- `npx tsc -p tsconfig.tests.json --noEmit` (CI parity) — clean.
- `npx vitest run tests/storage/ tests/sync/ tests/pipeline/ tests/doctor/` — **868/868** (78
  files), post-merge and post-renumber.
- `npx vitest run tests/config/ tests/proxy/` — **184/184** (21 files), additional sweep given the
  doctor-checks coexistence.

## CI: one failure, diagnosed as an unrelated pre-existing flake, re-run confirmed

First push: 4/5 checks green, "Test (self-hosted, Bun 1.3)" failed —
`scripts/eval/longmemeval/resume-integration.test.ts`'s SIGKILL-mid-ingest kill-resilience test,
asserting `firstManifest.ok_count` > 0, got 0.

Diagnosed before touching anything:
- Confirmed via `git diff --name-only main...HEAD` that this PR touches neither
  `scripts/eval/longmemeval/` nor anything adjacent to it — zero overlap with the diff.
- Read the test: it hardcodes a 200ms sleep before SIGKILL against 6 jobs each with an 80ms
  simulated ingest delay at concurrency 1, assuming "~2 of 6 complete" by kill time (test's own
  comment). On a loaded self-hosted runner (this run shared the box with the rest of a 310-file/
  4008-test suite), that timing assumption can slip in either direction — here, apparently zero
  jobs had completed by the 200ms mark, which is a scheduling/CPU-contention artifact, not a code
  defect.
- Re-ran only the failed job (`gh run rerun --failed`), no code change: passed clean the second
  time, full green, no other check regressed. This confirms flake, not regression.

All 5 checks green after the targeted re-run.

## Merge

Auto-merge fired automatically once all checks were green. Merge commit
`96bdad20839ad519dfef1b38a9df88212f7f5c26`.

## Anything red

Yes, once — the unrelated pre-existing CI flake above, diagnosed with evidence (diff scope check +
reading the test's own timing assumptions) before re-running, not retried blind. The
migration-numbering collision was caught locally before any push and resolved as a genuine defect,
not a CI red.

## Final state

- `main` HEAD is now `96bdad20` (PR #322's merge commit), on top of the L0 set, L1-3 (#317), and
  the ADR-017 flip (#321), plus the intervening #302/#318/#319/#320/#309 commits this branch's
  base had missed.
- `src/doctor/checks/index.ts` on `main` now registers `checkMigrationSelfHeal`,
  `checkHandlerRunLog`, and `checkRetention` alongside every prior addition — no clobbering.
- `migrations/` on `main` now has `044-consolidation-judge-near-threshold.sql`,
  `045-guard-usefulness-partial-indexes.sql`, `046-migration-self-heal-log.sql`, and
  `047-handler-run-log.sql` — no version collision.

## Heads-up carried forward

L1-1/L1-2 lanes are dispatching next and were told to take the next free migration number after
checking live main — that number is now **048**, not 044-046. Worth confirming with team-lead that
this got communicated to those lanes' builders before they pick a number.
