# Local dual-pass distill slowness + /health starvation / watchdog kill-storm — incident + remediation plan (2026-07-16)

status: DRAFT — pending architect + architect-reviewer sign-off before build

## Incident summary

Flipping prod extraction+compaction to local `ollama/qwen3:8b` with
`extractionPasses: 2` (dual-pass) took prod down. Root cause was a feedback
loop, not the flip alone:

1. Local dual-pass distill is heavy (2 sequential LLM calls/chunk on a
   ~35 tok/s model, one GPU, `OLLAMA_NUM_PARALLEL=1`), run on the daemon's
   worker. A long job starves the event loop enough that `/health` (and
   `/version`) stop answering within the watchdog's probe window.
2. Today's #370/#388 fix RE-ARMED the previously-dormant watchdog + keepalive
   (schtasks `AstraMemoryDWatchdog` PT3M + `AstraMemoryD` PT5M). The now-
   working watchdog saw 2 failed `/health` probes → killed the daemon →
   keepalive respawned → repeat, with the two tasks also racing the port
   (EADDRINUSE, dozens of exit-1s). Self-inflicted kill-storm.

Confirmed by: a single STANDALONE daemon with both scheduled tasks DISABLED
boots healthy in 12s, `/health` ok, `el_max ~200ms`, 5/5 stable probes.
Ruled out (each independently): the release (9512e02a which booted clean this
AM also wedges under the managed tasks), consolidation (kill-switch on didn't
help), the job queue (empty queue still wedged under the tasks), Ollama/VRAM
(freed to 2.3GB, still wedged under the tasks). The common factor was always
the watchdog+keepalive interaction, not the payload.

Rolled back: extraction+compaction → codex, `extractionPasses` → 1. Prod is
currently a MANUAL standalone daemon, watchdog+keepalive tasks DISABLED (temp
holding state, not the managed service). ASTRA_SKIP_CONSOLIDATE=1 via shim.

## Architecture: 1-way vs 2-way distill

Pipeline stages: chunk → compact(4) → extract(5) → reduce(6) → normalize(7)
→ embed+index(8). The ONLY difference:
- 1-way (`extractionPasses:1`): stage 5 = ONE LLM extraction call/chunk.
- 2-way (`extractionPasses:2`): stage 5 = pass A (primary) THEN pass B
  (`extractSpecifics`, the specifics-sweeper prompt re-reading the same chunk
  for missed atoms). TWO sequential LLM calls/chunk (B depends on A's output).

Disproportionately slow LOCALLY because: 2× calls on an already-slow model;
serial (B needs A); single GPU/Ollama lane (no concurrency to hide latency);
runs on the daemon worker so it starves `/health`. On codex (network, fast,
yields) 2-way was fine — it was disabled only for metered COST, not latency.

## Remediation plan (the 5 points under review)

**1. Make /health truly O(1) + loosen the watchdog (INCIDENT ROOT — P0).**
`/health` must never await a slow query, a busy DB lane, or the worker; it
should return cached liveness state only (the ADR-015 "liveness must be O(1)"
principle from the daemon-event-loop-saturation-triad postmortem). Separately,
the watchdog probe timeout + consecutive-failure threshold (`watchdog-probe.ts`
`DEFAULT_FAILURE_THRESHOLD`) must tolerate a daemon legitimately busy under
distill — a slow /health is not a dead daemon. Both halves needed: a fast
/health so the watchdog rarely trips, AND a watchdog that doesn't kill on a
single slow window.

**2. Offload distill LLM calls off the main event loop.** A heavy local
distill job must not block HTTP. Mirror the ONNX embed worker_thread offload
(ADR-018/ADR-019) — run the distill stage's provider calls / synchronous
hot spots off the main thread so the daemon stays responsive. Note: the
provider `chat()` calls already `await` (should yield); investigate whether
the starvation is actually the provider call or a synchronous hot spot
(chunking, JSON parse, tokenization, the embed batch) — fix the real blocker,
don't cargo-cult a worker.

**3. Parallelize pass B across chunks.** Pass A of chunk N+1 can run while
pass B of chunk N runs (they're independent across chunks; only A→B within a
chunk is ordered). Recovers wall-clock without changing extraction quality.
Bounded by the same concurrency cap the pipeline already has.

**4. FEAT-534 hybrid (already built, on main): codex pass A + local pass B.**
Keeps codex precision (94%) on the primary pass, gets qwen recall (84%) on the
sweeper, halves local load + halves metered cost vs full-codex dual-pass. The
pragmatic near-term path while 1-3 land.

**5. Bound per-job wall-clock for local distill.** `costCap` exists
(maxCallsPerJob/maxWallClockMs) but is tuned for metered call-count; add/tune
a GPU-time bound so no single local job monopolizes the single Ollama lane
and starves both other jobs and (pre-fix-1) /health.

## Recommendation (for review)

Do NOT re-flip to full-local 2-way until #1 and #2 land + soak. The bench win
(F1 76 vs codex 64) is real but the pipeline can't safely carry local
dual-pass on this hardware yet. Ship FEAT-534 (hybrid, #4) as the interim.
Release v0.19.0 is BLOCKED on #1 (the watchdog kill-storm is latent on any
box that re-arms the watchdog — which every reinstall now does).

## Open questions for the architects
- Is the /health starvation actually the provider await, or a synchronous
  hot spot? (Determines whether #2 is a worker offload or a targeted yield.)
- Should the watchdog distinguish "slow /health" (busy) from "dead /health"
  (no TCP accept) — e.g. a cheap TCP-accept liveness check separate from the
  full /health body?
- Does #1's "cached liveness /health" risk hiding a genuinely wedged daemon
  from the watchdog (the failure mode the watchdog exists for)? Where's the
  line between "busy, don't kill" and "wedged, do kill"?
