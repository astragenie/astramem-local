# Handoff: FEAT-548 ingest gatekeeper — build complete

- **Objective**: implement the FEAT-548 ingest gatekeeper — an optional
  pre-extraction chunk-level substantiveness gate inserted after stage 3
  (chunk) and before stage 4/5 (compact/extract) in the distill pipeline.
- **Owner**: crew:fullstack-dev (this build)
- **Worktree**: `C:\work\mega\astramemory-local-wt548`
- **Branch**: `feat/548-gatekeeper`
- **Tip SHA**: `919a005f` (rebased onto `feat/547-triage-v2` to resolve the
  migration 054 collision — see "Renumber" section below)
- **Base**: `feat/547-triage-v2` tip `dd0e1a3a` (which itself sits on wave-1
  merged tip `51052874`) — rebased from the original base after the
  migration-number collision was found; this is also the actual wave-plan
  merge order (547 lands before 548).

## Allowed scope
- New gate module + storage + config + pipeline wiring + doctor check +
  bench flag, per SLICE-441 / FEAT-548 spec.

## Forbidden scope
- Live LLM calls (GPU busy — mock providers only, per dispatch constraint).
- No `--gatekeeper` measurement RUN against the real 55-fixture bench (AC-4
  live measurement) — only the plumbing to make that run possible was built.

## Deliverable — files changed

New:
- `src/distill/gatekeeper.ts` — `GATEKEEPER_MARKER`, `gatekeeperBatch`,
  `GatekeeperRunTracker`, `runGatekeeperSweep` (mirrors `atom-triage.ts`
  field-for-field, one chokepoint earlier).
- `src/storage/gatekeeper-log.ts` — `recordGatekeeperSkips`,
  `recordGatekeeperRunLog`, `totalChunksEvaluated`, `totalChunksSkipped`,
  `gatekeeperSkipRate`.
- `migrations/055-gatekeeper-skips.sql` — `gatekeeper_skips` +
  `gatekeeper_run_log` tables (mirrors migration 052's two-table split).
  Renumbered from 054 -> 055 (see "Renumber" section below) after the
  parallel FEAT-547 branch was found to also claim 054.
- `src/doctor/checks/gatekeeper.ts` — `checkGatekeeper`, single-bound
  (>=95% skip-rate) alarm, tier `'full'`, gated on `MEANINGFUL_USAGE_THRESHOLD`.
- `tests/distill/gatekeeper.test.ts`, `tests/config/gatekeeper-boot-governance.test.ts`.

Modified:
- `src/config/config.ts` — `Config['distill']['gatekeeper']` type,
  `defaultConfig()` default (`mode: 'off'`), `applyGatekeeperGovernance`,
  wired into `loadConfig()`.
- `src/config/loader.ts` — `applyGatekeeperGovernance` wired into
  `loadConfigFromDisk` (the real boot path).
- `src/config/writer.ts` — round-trip emission of the `gatekeeper` block.
- `src/providers/index.ts` — `ProviderSet.llm.gatekeeper`, identity-default
  build in `getProviders`.
- `src/distill/pipeline.ts` — stage 3b gate insertion, `chunksForExtraction`
  variable threaded through compact/extract (leaves original `chunks` /
  `chunksProcessed` untouched), `recordExtractionYield`'s `chunksIn` now
  counts only chunks that actually reached extraction (post-gate).
- `src/pipeline/handlers/distill.ts` — `llmGatekeeper` threaded into
  `PipelineContext`.
- `src/doctor/checks/index.ts`, `src/doctor/checks/shared.ts`,
  `src/cli/serve.ts`, `src/cli/doctor.ts` — `gatekeeperMode` doctor wiring +
  LLM chat probe role.
- `scripts/eval/extraction-bench/lib/daemon-runner.ts`,
  `scripts/eval/extraction-bench/run-bench.mts` — `--gatekeeper
  off|dry-run|enabled` flag (mirrors `--atom-triage`), pins the gatekeeper
  provider to the same extraction candidate model.
- `tests/config/config.test.ts`, `tests/config/writer.test.ts`,
  `tests/distill/pipeline.test.ts` — fixture updates + new
  `runPipeline — FEAT-548 ingest gatekeeper` describe block.

## Notable in-flight fix

`pipeline.ts`'s compact-result empty-fallback used to look up
`chunks[r.index]` — a POSITIONAL array index, silently correct pre-FEAT-548
only because `chunk.index` always equaled its own array position (chunks
were never filtered). Introducing `chunksForExtraction` filtering in
`'enabled'` mode breaks that coincidence (a `skip`-removed chunk shifts every
later chunk's array position away from its own `.index` value), so the
lookup was fixed to a `Map<number, Chunk>` keyed by the chunk's real
`.index` field.

## Renumber: migration 054 -> 055 collision with FEAT-547

The parallel `feat/547-triage-v2` branch also created a `migrations/054-*.sql`
(`054-atom-triage-v2.sql`), and 547 merges before 548 per the wave plan.
Sequence of fixes, in order:

1. `git mv migrations/054-gatekeeper-skips.sql migrations/055-gatekeeper-skips.sql`
   + fixed the file's own self-referenced header comment (`-- 054: ...` ->
   `-- 055: ...`) + the one other hardcoded reference,
   `src/storage/gatekeeper-log.ts`'s doc comment (`migration 054` ->
   `migration 055`). Grepped the whole branch for any other `054` tied to
   gatekeeper — none found (`SCHEMA_VERSION` is derived from the
   `migrations/` directory listing, per `src/storage/schema-version.ts`,
   never hand-declared — confirmed nothing hardcodes it).
2. This alone made THIS branch non-contiguous in isolation (053 -> 055, no
   local 054 — the repo enforces strict 1..N contiguity via
   `tests/storage/migration-renumber.test.ts` and
   `SCHEMA_VERSION`-row-count assertions in `migrate.test.ts`, both of which
   went RED). The gap only makes sense once FEAT-547's own 054 migration is
   present.
3. Resolved by rebasing `feat/548-gatekeeper` onto `feat/547-triage-v2`
   (`dd0e1a3a`) — this is also the actual wave-plan merge order, so the
   rebase isn't a workaround, it's doing now what integration would do
   later anyway. Two mechanical, additive conflicts (both branches append a
   new bench-flag lever to the same options object/type in
   `scripts/eval/extraction-bench/run-bench.mts` and
   `lib/daemon-runner.ts` — FEAT-547's `--triage-model`, FEAT-548's
   `--gatekeeper`); resolved by keeping both additions. All three original
   commits replayed cleanly on top of 547's tip, migrations directory is
   now contiguous 001..055, and the full targeted suite (see Evidence below)
   went green.

This is the repo's own #229 "nine collisions in one day" class (see
`docs/specs/20260713-stability-wave-plan.md` §B4 / `schema-version.ts`'s
doc comment) — the wave plan should pre-assign migration numbers per branch
to avoid this recurring; noted here for the retro.

## Evidence

Pre-rebase (original base `51052874`, migration `054-gatekeeper-skips.sql`):
- `bun run build` — clean.
- `npx tsc -p tsconfig.tests.json` — clean.
- `npx tsc -p tsconfig.eval.json` — clean.
- `npx vitest run tests/distill/ tests/config/` — 38 files / 751 tests green.
- `npx vitest run tests/doctor/ tests/storage/ tests/pipeline/` — 89 files /
  977 tests green.
- `npx vitest run tests/providers/` — 20 files / 402 passed, 14 skipped
  (pre-existing skips, unrelated to this change).

Post-renumber + post-rebase onto `feat/547-triage-v2` (migration
`055-gatekeeper-skips.sql`, contiguous after 547's own `054-atom-triage-v2.sql`):
- `bun run build` — clean.
- `npx tsc -p tsconfig.tests.json` — clean.
- `npx tsc -p tsconfig.eval.json` — clean.
- `npx vitest run tests/distill/ tests/config/ tests/storage/` — 64 files /
  1180 tests green (includes `migration-renumber.test.ts`'s contiguity
  invariant and `migrate.test.ts`'s `SCHEMA_VERSION` row-count assertions,
  both of which were RED against the isolated pre-rebase branch alone —
  see "Renumber" section below).
- `npx vitest run tests/doctor/ tests/pipeline/ tests/providers/` — 84 files
  / 967 passed, 14 pre-existing skips.
- `ASTRA_SKIP_CONSOLIDATE` was unset before every test run per constraint.

## AC checklist

- **AC-1** (mode `'off'` byte-identical): PASS — `runPipeline — FEAT-548
  ingest gatekeeper` describe block, test "mode 'off' ... never calls the
  gatekeeper provider"; asserts 0 rows in both new tables.
- **AC-2** (fail-open on provider throw): PASS — "a throwing gatekeeper
  provider fails OPEN under mode 'enabled'" test; asserts the chunk WAS
  extracted (`memoriesCreated === 3`), not merely that no exception
  propagated, plus DB-row evidence (`chunks_skipped: 0`).
- **AC-3** (dry-run logs + DB rate counter, never filters): PASS — "mode
  'dry-run' — a 'skip' verdict is logged (DB rows)..." test; asserts
  `gatekeeper_run_log`/`gatekeeper_skips` rows AND that extraction still ran
  unfiltered.
- **AC-4** (55-fixture dry-run measurement, 0% false-skip on substantive
  fixtures): PLUMBING ONLY — `--gatekeeper` flag built and wired through
  `daemon-runner.ts`'s config.yaml emission (mirrors `--atom-triage`); the
  live measurement run itself was NOT executed (GPU busy constraint, mock
  providers only this dispatch). Follow-up: run
  `run-bench.mts --gatekeeper dry-run` against the 55-fixture set once GPU
  capacity is available.
- **AC-5** (skip-rate observable + doctor WARN at >=95%): PASS for the
  structured-log + DB-persisted-rate half (`pipeLog.info({stage:
  'gatekeeper', skip_rate, ...})`, `gatekeeper_run_log` table) and the doctor
  canary half (`checkGatekeeper`, `SKIP_RATE_ALARM = 0.95`, gated on
  `MEANINGFUL_USAGE_THRESHOLD`). No production data exists yet to exercise
  the WARN path live — covered by the doctor check's own code path, not a
  dedicated doctor-check unit test in this dispatch (no `tests/doctor/*
  gatekeeper*` test file was added — narrow gap, follow-up).

## Risks / follow-ups

- AC-4's live measurement (55-fixture dry-run bench run) still needs to
  happen once GPU/Ollama capacity frees up — this build only made it
  runnable.
- No dedicated `tests/doctor/gatekeeper-check.test.ts` unit test for
  `checkGatekeeper` itself (sibling checks like `atom-triage.ts` also lack
  one in this repo's convention — checked via `tests/doctor/` sweep passing,
  not a regression, but worth a small follow-up for direct coverage of the
  95% alarm threshold logic).
- Migration number 054 was free at build-commit time (base tip's last
  migration was 053) but collided with the parallel FEAT-547 branch
  (`054-atom-triage-v2.sql`), which merges before 548 per the wave plan.
  Renumbered 054 -> 055 (file + self-referenced header comment + the one
  `storage/gatekeeper-log.ts` doc-comment reference) once the collision was
  flagged. This is the repo's #229 nine-collisions-in-one-day class —
  re-verify against the tip actually being merged onto (not just the
  worktree's own base) before any future migration-bearing branch merges;
  the wave plan should pre-assign migration numbers per branch to prevent
  this recurring.
