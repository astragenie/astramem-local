# Handoff — FEAT-483 SLICE-3: queue-liveness starvation canary

**Objective**: Build a canary that asserts distill throughput stays nonzero while a
consolidation job runs — guarding against the FEAT-482 incident class (contradiction
judge burned ~245 metered LLM calls per consolidation run and starved the worker;
distill frozen at 32 pending / 0 running for an hour).

**Owner**: fullstack-dev (this dispatch)

**Allowed scope**: new test file only (`tests/pipeline/*` or `tests/e2e/*`). No product
source edits — this is the canary, not the fix.

**Forbidden scope**: FEAT-482's actual fix (worker-lane isolation / batching so a
consolidate job can't monopolize a lane distill jobs need). That is separate,
not-yet-landed follow-up work.

**Deliverable**: `tests/pipeline/queue-liveness-starvation.test.ts`

- One `describe` block, one `it.fails(...)` test.
- Reproduction: registers a slow `consolidate` handler (20 sequential 40ms-delayed
  awaits, ~800ms total) and a trivial `distill` handler that just increments a
  counter. Enqueues the consolidate job first (claimed first under FIFO
  `JobRepo.claimPending()` ordering), then 5 distill jobs. Starts the worker with
  `pipeline.concurrency: 1` — the AC's explicit "single worker lane" case (production
  default is now 2 per FEAT-482's earlier concurrency-raise mitigation, but that
  mitigation does NOT add per-kind lane isolation — with only one lane, or whenever
  every lane happens to be occupied, this reproduces regardless of the default).
  After a 300ms liveness window (comfortably shorter than the consolidate job's
  ~800ms total runtime), asserts `distillCompletions > 0` and that not all 5 distill
  jobs are still `pending`.
- **Why `it.fails()` and not `it.skip`**: the starvation is deterministic, not
  timing-flaky. With `concurrency: 1` there is structurally exactly one lane;
  `worker.ts`'s per-lane `launchTick`/`scheduleNext` only claims the next job after
  the current tick's `handler.handle()` promise resolves, so it is physically
  impossible for a distill job to be claimed while the slow consolidate handler's
  promise is still pending — no scheduler jitter can make this test flip to green
  today. `it.fails()` genuinely exercises the bug and reports "expected fail" in
  vitest's output (not a red build); once FEAT-482's lane-isolation fix lands, the
  assertions will start passing and `it.fails()` must be removed (a passing body
  under `it.fails()` is itself a vitest failure) — that flip is the signal the fix
  landed.
- No lane reservation by job kind exists anywhere in the pipeline today — confirmed
  by reading `src/pipeline/worker.ts`, `src/pipeline/job-repo.ts` (`claimPending()`
  claims oldest-pending regardless of `kind`), and `src/pipeline/registry.ts` (a flat
  `Map<JobKind, JobHandler>` with no kind-to-lane binding). This is exactly the gap
  FEAT-482's remaining work needs to close.

**Changed files / evidence**:
- `tests/pipeline/queue-liveness-starvation.test.ts` (new)
- `bunx vitest run tests/pipeline/queue-liveness-starvation.test.ts` → 1 expected fail
- `bunx vitest run tests/pipeline tests/e2e` → 21 files passed, 186 passed / 1 expected
  fail (built `dist/` first via `bun run build` — it did not exist in this worktree;
  4 e2e daemon-spawn tests failed with `MODULE_NOT_FOUND` before the build, unrelated
  to this change, and passed cleanly after)
- `bunx tsc --noEmit -p .` → clean
- `bunx tsc --noEmit -p tsconfig.tests.json` → clean
- PR: https://github.com/astragenie/astramem-local/pull/451

**Confidence**: High — the reproduction is structural/deterministic (verified by
reading the actual claim/schedule code path in `worker.ts`), not inferred from the
incident narrative alone.

**Risks / open questions**: None new introduced. The canary documents (does not fix)
an unresolved hazard. Left as a `needs FEAT-482` follow-up — no new FEAT filed since
FEAT-482 already exists and covers this exact remediation per CLAUDE.md's incident
record.

**Suggested next handoff**: FEAT-482 follow-up — implement per-kind lane isolation or
batching in `src/pipeline/worker.ts` / `job-repo.ts` so a `consolidate` job cannot
occupy a lane that queued `distill` jobs need; then remove `it.fails()` from this test
so it becomes a real green regression guard.
