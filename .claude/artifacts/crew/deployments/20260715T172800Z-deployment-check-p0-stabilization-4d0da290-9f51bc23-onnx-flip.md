# Deployment check — P0 stabilization: releases 4d0da290 + 9f51bc23 + onnx config flip

- Date: 2026-07-15T17:28Z
- Deployer: lead-session (user-approved P0 execution)
- Plan: `.claude/artifacts/crew/handoffs/20260715T1630Z-stabilization-analysis-and-plan-crash-loop-event-loop-stalls.md` (v2)

## What shipped

| Step | Evidence |
|---|---|
| P0.1 PR #355 merged (`4d0da290`) — shim ×3, SonicBoom logging, KNN worker offload, /health O(1), kill-switch, reinstall polling, rate limiter; ADR-019-supervisor renumbered → ADR-020 | CI green after 2 legit test fixes (pre-existing dual-pass asserts broken on main; SonicBoom reopen race de-flaked) |
| P0.2 release `0.19.0-beta.0+4d0da290` deployed | post-merge hook auto-reinstalled; /health dropped from 10s-timeouts to **5.8ms**; daemon calm, no restart needed; `ASTRA_SKIP_CONSOLIDATE=1` set at user level as fallback only |
| P0.3 PR #356 merged (`9f51bc23`) — full ONNX stack + worker offload; review MEDIUM (shutdown order) fixed IN the merge | ab38d7c approved_with_notes; 2 main-side default-assert tests made flip-proof |
| P0.4 config flip `embedding.provider: ollama → onnx` (backup `config.yaml.bak-pre-onnx`) + `reinstall` → release `0.19.0-beta.0+9f51bc23` | reinstall verified healthy; boot log: "onnx embed preload ok", "embed preflight ok (attempt 1): onnx/mxbai-embed-large returned 1024-dim" |

## Post-deploy verification (live prod, 36k-atom DB)

- `onnx embed ok latency_ms=26` — vs Ollama's measured **62,000–142,000 ms** during the same-day saturation incident.
- `/recall` end-to-end through onnx embed + KNN worker offload: cold 3.5s, warm 868/847/926 ms.
- `/health` **5.6–6.6 ms**, including DURING concurrent recalls — event loop free; watchdog can no longer misread busy as dead on this path.
- Worker alive, tick lag 13ms. Old releases pruned to 2 (9f51bc23 + 4d0da290 rollback target).
- One soak PROBE-FAIL at the reinstall restart window (expected artifact, not a stall).

## Rollback

`node dist/cli/index.js reinstall --rollback` → repoints at `0.19.0-beta.0+4d0da290`. Config flip reversible via `%APPDATA%\Astramem\config.yaml.bak-pre-onnx`.

## Not done here (plan P1/P2)

Restart-storm circuit breaker, event-loop-lag canary, liveness/readiness split, job backpressure, boot stagger, consolidate k-NN — designs ready in `.claude/artifacts/crew/handoffs/20260715T1645Z-design-memo-architect-p1-p2-stabilization-designs.md`. Owed: FEAT-506 orphan decision, dual-pass LoCoMo revalidation, 0.20.0 promotion after soak.
