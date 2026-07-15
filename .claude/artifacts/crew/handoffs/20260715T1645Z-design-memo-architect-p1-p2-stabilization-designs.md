# Design memo — architect P1/P2 stabilization designs — 2026-07-15T16:45Z

Companion to `.claude/artifacts/crew/handoffs/20260715T1630Z-stabilization-analysis-and-plan-crash-loop-event-loop-stalls.md`. All designs verified against live source. Condensed; each design gives mechanism / files / config / failure behavior / tests.

## 1. Watchdog restart-storm circuit breaker
- New append-only `<dataDir>/logs/watchdog-kills.jsonl`, written in `watchdog-probe.ts` on the `stopResult.ok===true` branch (~line 226). Before `stopLockHolderFn` (~line 200): count kills in rolling 6h window; if ≥3 → skip kill, return `action:'breaker-tripped'`. Do NOT reset failure counter. Self-clearing (rolling window), no reset logic. Does NOT touch shim.ts's embedded launcher.
- Fail-open direction justified: this week's failure was busy-misread-as-dead 100% of the time; a truly wedged daemon tripping the breaker needs a human via doctor RED — accepted tradeoff.
- Doctor: new `src/doctor/checks/restart-storm.ts`, `tier:'cheap'`, mirrors `crash-loop.ts`, reports count+window (rate, not boolean). Register in `checks.ts`.
- Constants hardcoded (`RESTART_STORM_THRESHOLD=3`, `WINDOW=6h`) per `CRASH_LOOP_THRESHOLD` precedent — no new config-drift vector.
- Tests: 3-in-window → 4th cycle skips kill (stub call count stays 3); stale kills age out; doctor RED/GREEN/inconclusive-on-unreadable.

## 2. Event-loop-lag canary
- `perf_hooks.monitorEventLoopDelay({resolution:20})` in new `src/server/event-loop-lag.ts`; `getP99Ms()`/`getMeanMs()` are O(1) native reads — canary read can never itself block. Wire `healthState.eventLoop = {p99Ms, meanMs, windowStartedAt}`; reset histogram on the 15-min frequent-doctor cadence so window is recent, not lifetime.
- RED at p99 > 1000ms (measured stalls 15–219s; 1s is ~10× fast-path, well under 10s watchdog probe timeout).
- Report numeric p99/mean, never boolean (canary-rate rule). Cold-start: window age <60s → `inconclusive`, not GREEN.
- Files: event-loop-lag.ts (new), health-state.ts, serve.ts, routes/health.ts, doctor/checks/event-loop-lag.ts (new, cheap tier), checks.ts.
- Tests: injectable fake histogram (same pattern as `fetchImpl`).

## 3. Liveness/readiness split for /health
- Current `/health` runs 4 sync SQLite reads per request (usefulnessRate, queueCounts, pendingProposals COUNT, buildMemoryHealthCheap) + statfsSync. Move ALL DB-backed fields into `healthState.snapshot`, refreshed off-request by unref'd 30s interval. `/health` handler = pure in-memory read, ZERO `db.prepare()` — enforce at type level: lean route builder takes no `db` param. Add `snapshot_age_ms` (staleness visible).
- New `/health/full` = today's behavior verbatim (rename) for dashboard.
- Watchdog contract unchanged (`probeHealth` only checks HTTP 2xx). This removes DB contention from /health latency; event-loop stalls handled separately by ADR-019.
- Failure: refresher throws → keep last-good + log; cold boot → nulls with `computedAt:null`.

## 4. Job backpressure
- Hook: `src/pipeline/worker.ts` lane tick (`createLane` ~line 114); concurrency currently fixed at `startWorker()` — needs live-adjustable `activeLaneBudget`.
- New `src/pipeline/backpressure.ts`:
  - `EmbedLatencyTracker` — EWMA (α≈0.3, seed 1000ms) fed at the existing `recordHandlerRun` call sites, scoped to `distill`/`reembed`. Staircase multiplier: 1.0 normal, 0.5 at ewma>5s, harder step at ewma>20s (measured 62–142s makes one halving at concurrency=2 meaningless).
  - `RetryBudgetTracker` — aggregate sliding-window retry rate. GAP FOUND: worker.ts backoff (~lines 219-233) is deterministic, NO jitter → lockstep retry storms. Fix: ±30% jitter + clamp delay floor upward when aggregate retry rate exceeds threshold.
- Two levers off one tracker: (a) coarse lane-claim gate via shared `activeLaneBudget`; (b) fine — reembed handler reads tracker to shrink batch size + inter-batch sleep (the lever that matters at concurrency=2). Thread via `HandlerCtx`.
- FEAT-482 guards (`maxPerRun`/`maxWallClockMs`) are SIBLING guards (contradiction judge LLM calls, per-run scope) — document as non-overlapping, not superset.
- Config: `config.pipeline.backpressure:{slowThresholdMs:5000, severeThresholdMs:20000, retryBudgetPerMin:20}`.
- Failure: pure in-memory; NaN/first-sample → multiplier 1.0 (assume normal), never max-throttle.

## 5. Boot stagger
- Confirmed hazard: `job-repo.ts:123` `recoverOrphans()` at boot + `serve.ts:247` lanes start immediately + `serve.ts:446` `enqueueConsolidate()` fires synchronously at startup → full-concurrency claim of a just-refilled queue while proving liveness to watchdog.
- Fix: (a) delay FIRST `enqueueConsolidate` by 5 min (`setTimeout`, then start 6h interval from there) — past one full watchdog probe cycle (180s); (b) `recoverOrphans` stays immediate (cheap state flip) — throttle CONSUMPTION: `startWorker({initialActiveLanes:1})` + ramp 1→half→full at 60s steps, reusing design 4's `activeLaneBudget` (one lane-limiting mechanism, two uses).
- Matches existing degraded-start philosophy (serve first, catch up second).
- Config: `config.pipeline.bootRamp:{delayMs:300_000, rampStepMs:60_000}`.
- Failure: ramp timer dies → stuck at 1 lane = degraded throughput, never zero, never crash.

## 6. Consolidate at scale — k-NN candidate selection (replaces flat O(n²) AND the binary group-skip)
- Current: C(500,2)=124,750 pairs/group cap; Tier-1 yields bound STALL DURATION not TOTAL WORK; groups >500 skipped entirely (silent coverage gap — see reviewer MEDIUM).
- Design: keep (repo,type) grouping → per atom, query top-K≈30 neighbors via EXISTING `SqliteVecStore.search()` (same infra /recall uses — proven, no new dependency) → dedup symmetric pairs via canonical min/max-id Set (same pattern as existing proposal dedup ~line 475-489) → run existing similarity/containment/judge logic unchanged over reduced set. O(n²)→O(n·k): ~1M pairs vs ~657M at n=36k.
- Plus explicit `maxCandidatePairsPerRun` ceiling with DETERMINISTIC resumable-cursor truncation (created_at asc) — never Map-insertion-order truncation (would permanently starve tail groups). Resumable cursor = guaranteed forward progress on the 768-proposal backlog.
- Ship opt-in: `consolidate.candidateSelection: 'full'|'knn'` (default 'full'), promote via P2.1 soak test.
- OPEN UNKNOWN (verify first at build time): sqlite-vec MATCH/k syntax — same-query metadata filter vs post-filter with larger K.
- Tests: 2000-atom seeded-duplicate fixture — knn recall parity vs full; pair count ≪ C(n,2); wall-clock drop; two-runs-with-low-ceiling cover what one full run does (no starvation).
- Operational: post-deploy, confirm 768 backlog shrinks over several runs (explicit soak-test check).

## Merge order verdict: `session/beta-stabilization-waves` FIRST, ONNX second
1. Prod runs an unmerged orphan build NOW — deploy pipeline must be fixed before anything ships through it.
2. Beta-stabilization = smaller, proven surface (shim/logging/reinstall); ONNX = new native dependency needing real review — review it in parallel, don't block the bleeding-stop on it.
3. Conflict surface low: only real overlap `config.ts` (additive blocks) + ADR-018 doc (hard-conflict, resolve toward ONNX canonical). Rebase ONNX on the LOCAL post-merge tip (merge-local-tip-not-origin lesson).
4. P0 reinstall happens AFTER beta-stabilization merge; ONNX follows as second release once review clears.
- NOTE (lead resolution of reviewer/architect disagreement): architect read ADR-019's doc table saying Decision-2(d) offload "deferred" — STALE relative to the branch; commit `ab38d7c` is literally that offload and reviewer verified `onnx-worker-host.ts` on-branch. Offload EXISTS; the ab38d7c review should confirm which embed roles (ingest + query) it covers before the default/config flip.
