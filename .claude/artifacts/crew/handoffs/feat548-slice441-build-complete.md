# Handoff: FEAT-548 ingest gatekeeper — build complete

- **Objective**: implement the FEAT-548 ingest gatekeeper — an optional
  pre-extraction chunk-level substantiveness gate inserted after stage 3
  (chunk) and before stage 4/5 (compact/extract) in the distill pipeline.
- **Owner**: crew:fullstack-dev (this build)
- **Worktree**: `C:\work\mega\astramemory-local-wt548`
- **Branch**: `feat/548-gatekeeper`
- **Tip SHA**: `907552c3`
- **Base**: wave-1 merged tip `51052874`

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
- `migrations/054-gatekeeper-skips.sql` — `gatekeeper_skips` +
  `gatekeeper_run_log` tables (mirrors migration 052's two-table split).
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

## Evidence

- `bun run build` — clean.
- `npx tsc -p tsconfig.tests.json` — clean.
- `npx tsc -p tsconfig.eval.json` — clean.
- `npx vitest run tests/distill/ tests/config/` — 38 files / 751 tests green.
- `npx vitest run tests/doctor/ tests/storage/ tests/pipeline/` — 89 files /
  977 tests green.
- `npx vitest run tests/providers/` — 20 files / 402 passed, 14 skipped
  (pre-existing skips, unrelated to this change).
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
- Migration number 054 was free at commit time (base tip's last migration
  was 053); re-verify against `origin/main` before this branch is rebased/
  merged, per the repo's migration-number-collision lesson.
