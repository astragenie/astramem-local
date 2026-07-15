---
findings: "🔴:0,🟡:1,❓:0"
status: completed
decision: approved_with_notes
---
# Review Result — ab38d7c (ONNX worker_thread offload, ADR-019 Decision 2(d))

- Created: 2026-07-15T16:50Z
- Reviewer: crew:typescript-reviewer (read-only, no checkout)
- Branch: worktree-agent-a7f5391444d082db3
- Decision: **approved_with_notes** — ship-worthy; one MEDIUM to fix at/right-after merge

## Role coverage (the gate question) — ANSWERED
Offload covers **BOTH** ingest-path AND query-path embeds. serve.ts builds ONE `providers.embed` (`OnnxWorkerHostProvider`, one worker_thread): passed raw to `buildApp` (query /recall path) and wrapped in `CachingEmbedProvider` for distill/ingest — same underlying provider, single worker. Config flip to onnx is safe for recall latency per ADR-019 intent.

## [MEDIUM] shutdown ordering races worker-drain guarantee
serve.ts `shutdown()` calls `terminableEmbed.terminate()` BEFORE `await worker.stop()`, but `WorkerHandle.stop()` promises in-flight ticks complete first. SIGTERM during a mid-flight embed → shutdown-induced job failure (self-healing via retry, not data-lossy, but regresses a documented invariant). **Fix: swap order — `await worker.stop()` first, terminate onnx worker after.** Apply during ONNX merge.

## Confirmed sound
- Crash → all pending rejected immediately (no hang), lazy respawn, no unbounded restart loop, failed spawn not memoized — all directly tested.
- Correlation: monotonic ids, per-path settle-exactly-once, late replies discarded.
- Errors: per-request `embed-error` vs thread-death cleanly separated; Float32Array zero-copy transfer.
- No zombie workers on graceful stop; SIGKILL takes worker down (Node semantics).
- Test coverage of onnx-worker-host.ts: no untested branch found; runs shared embed contract suite.

## Follow-ups (non-blocking)
- No backpressure cap on concurrent in-flight requests to one worker (pre-existing class, not new) — ticket, feeds P1.4 backpressure work.
- Stale doc comment in doctor/checks/onnx-embed.ts (cosmetic).
