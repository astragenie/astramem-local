# Stabilization analysis + plan — 2026-07-15 crash loop / event-loop stalls

**v2 (16:50Z)** — amended after architect-reviewer (verdict: approve_with_notes, 1 BLOCKER) and architect design pass. See:
- review: `.claude/artifacts/crew/reviews/20260715T1640Z-review-stabilization-plan-architect-reviewer.md`
- designs: `.claude/artifacts/crew/handoffs/20260715T1645Z-design-memo-architect-p1-p2-stabilization-designs.md`

- Created: 2026-07-15T16:30Z
- Owner: lead-session (analysis); builders per phase below
- Objective: root-cause today's daemon instability, define the durable fix sequence and the prevention measures
- Confidence: high on the failure chain (measured live); medium on the exact sync op inside each stall (Tier-2 isolation fixes the class regardless)

## Live evidence (measured 16:16–16:27Z, daemon PID 173476, release 0.19.0-beta.0+3762cc8a)

- `/health` timed out 10s × 5 consecutive probes, then later answered in 97ms — intermittent, not dead.
- `/version` (static endpoint) took **7.5s** — direct proof the **event loop blocks**, not just slow handlers.
- Log-gap analysis (`daemon.live.log`): silent windows of **219s, 34s, 33s, 28s, 23s, 23s, 15s**, every gap bracketed by `ollama embed ok` lines.
- Ollama embed latencies climbing **62s → 96s → 119s → 142s** (normal <1s for a 334M model) = server-side queue saturation.
- Ollama has TWO embed models pinned in VRAM indefinitely (`mxbai-embed-large` F16 + `qwen3-embedding:0.6b` — the latter not ours, likely an eval shard) on the 8GB box.
- Today's job volume (rotated `daemon.3.log`): **602 distill, 171 reembed, 32 consolidate, 32 cleanup** + distill retries (`operation aborted due to timeout`, `fetch failed`) re-amplifying load.
- `exit-history.jsonl`: **5 kills (exit 4294967295) + 5 crashes (exit 1)** between 12:05Z and 14:20Z — durations 5–30 min each. Classic watchdog-kill loop.
- DB: 36,495 active atoms; `pending_proposals: 768`; doctor RED on "Crash loop".

## Failure chain (the whole day in one sentence each)

1. **Demand spike**: dual-pass extraction default (#348, 2× LLM+embed per distill) + #507 reembed-oversize backlog (171 jobs) + consolidate auto-enqueued at boot on 36k atoms + retry amplification → Ollama embed queue saturates (60–140s/embed).
2. **Event loop stalls** 15–219s during these jobs. The Tier-1 yield fix (b6f53e4) is live and insufficient — ADR-018's own prediction; sync work between awaits (better-sqlite3 vec writes, compact/JSON on big payloads, O(n²)-scale consolidate chunks at n=36k) still starves the loop.
3. **Watchdog misclassifies busy as dead**: 2 consecutive `/health` failures (3-min interval probe) → kills the daemon mid-work.
4. **Restart storm**: boot requeues orphaned jobs + re-enqueues consolidate → instant re-saturation → next kill. Loop ran ~7 cycles today.
5. **Deploy fragility multiplies it**: prod runs an unmerged branch build; the shim fixes (3 root causes: stdout inherit crash, silent 'ignore', bad JSON escaping in current.json) and SonicBoom logging fix live ONLY on `session/beta-stabilization-waves`. Any `reinstall` from main regresses all of it.

## Why is Ollama still in the path at all? (operator question)

Because **ONNX never merged**. The full stack — provider, registry, default flip, worker_thread offload — is on `worktree-agent-a7f5391444d082db3` @ `ab38d7c` (9 commits). Parity proven (0.989 cosine vs Ollama-mxbai, 0/200 below gate), event-loop-safe with the offload (20ms lag vs 3907ms in-process). Only `ab38d7c` lacks review. Live release contains zero onnx code; live config says `provider: ollama`. ONNX merge removes Ollama from the embed hot path entirely: no GPU contention, no shared-queue saturation, embeds isolated in a worker thread.

## Plan

### P0 — stop the bleeding (today/tomorrow) — v2 REORDERED per review

| # | Action | Why | Owner |
|---|---|---|---|
| 0.1 | **Merge `session/beta-stabilization-waves` to main FIRST** (shim ×3, SonicBoom, reinstall `/version` polling, `ASTRA_SKIP_CONSOLIDATE`, LLM rate limiter, usefulness IN() batch). During merge: **renumber `ADR-019-windows-supervisor-process.md` → ADR-020** (collides with main's ADR-019-worker-isolation). Hand-verify `serve.ts` shutdown-sequence region — no silent `--no-edit` merge. | Deploy pipeline must be fixed before anything ships through it; prod runs an orphan build NOW | lead |
| 0.2 | Cut + `reinstall` a release from merged main **with `ASTRA_SKIP_CONSOLIDATE=1` MANDATORY** (not fallback). Soak 30 min: `/health` p99 + zero watchdog kills → then re-enable consolidate. | Boot without the flag re-enqueues consolidate on 36k atoms → reproduces the exact storm being fixed (P1 protections don't exist yet) | deployer |
| 0.3 | Review `ab38d7c` (typescript-reviewer; runs in PARALLEL with 0.1–0.2; confirm offload covers both ingest + query embed roles) → **merge ONNX branch second**, rebased on the LOCAL post-merge tip. Hand-resolve `ADR-018-onnx...md` (hard-conflicts, both branches carry different content) **toward the ONNX branch's canonical version** — never `--ours`/`--theirs` (PR #229 class). Watch `config.ts` (additive blocks). | ONNX = new native dependency, needs real review; don't block the bleeding-stop on it | reviewer → lead |
| 0.4 | **⚠ BLOCKER fix — the merge alone moves ZERO embeds off Ollama.** Prod `config.yaml` has `embedding: provider: ollama` EXPLICITLY set; deep-merge preserves explicit values, the onnx default only applies when the key is omitted. Required: stop daemon → edit `config.yaml` → `embedding.provider: onnx` → start → verify via doctor's onnx-embed check. (Config read once at boot; stop first per CLAUDE.md.) | Without this step P0's headline claim is false | operator |
| 0.5 | Interim (if 0.1–0.2 slip): raise watchdog failure threshold 2→3 and/or start daemon with `ASTRA_SKIP_CONSOLIDATE=1` | Break the kill loop without code | operator |

Fresh-box note: the LLM rate limiter needs the CONFIG KEY (`llm.rateLimit.callsPerMinute: 20`) set, not just the code merge — prod already has it; provisioning docs must say so.

### P1 — make busy ≠ dead (this week)

> v2: each item below now has a full buildable design (mechanism, files, config, failure behavior, tests) in the architect design memo — build from that, not from these summaries.

1. **Watchdog restart-storm circuit breaker**: if watchdog killed the daemon ≥3× in 6h (read `exit-history.jsonl`), stop killing, go RED in doctor + structured alert. A kill loop must be self-detecting.
2. **Liveness vs readiness split**: `/health` (watchdog target) must answer from a pre-computed cached snapshot; heavy fields move to `/health/full`. A wedged loop still fails it — that's correct — but slow jobs must not.
3. **Event-loop lag canary** (`perf_hooks.monitorEventLoopDelay`): export p99 loop lag in `/health` + doctor `tier:'cheap'` check RED at p99 > 1s. Today's stalls were invisible until a human curled. Rate-based, per ADR-015/canary-rate rule.
4. **Job backpressure**: cap concurrent embed-heavy jobs (reembed batch size + inter-batch sleep); adaptive backoff keyed on embed-latency EWMA (>5s ⇒ halve concurrency). Retries with jittered exponential backoff + retry budget so `fetch failed` storms can't self-amplify.
5. **Boot storm stagger**: after restart, delay consolidate + reembed enqueue by N minutes and ramp; boot should serve traffic first, catch up second (degraded-start philosophy applied to jobs).

### P2 — prevention / process (next)

1. **Saturation soak test**: scripted flood (parallel distill + reembed on a 30k-atom fixture DB) asserting `/health` p99 < 500ms and zero watchdog kills for 30 min. Gate ONNX-default and any future job-kind on it.
2. **Consolidate at n=36k — k-NN candidate selection** (v2, full design in memo §6): per-atom top-K≈30 neighbors via the EXISTING `SqliteVecStore.search()` (O(n²)→O(n·k), ~1M vs ~657M pairs), keeping the similarity/judge logic unchanged. MUST also **replace the silent binary group-skip** (`consolidate.ts:551-558` skips any group >500 atoms ENTIRELY, forever — `groupsSkipped` computed but read NOWHERE; new bug found in review) with partial top-K coverage + a doctor/health surface for groupsSkipped. Ceiling `maxCandidatePairsPerRun` truncates via deterministic resumable cursor (never insertion order — would starve tail groups). Ship opt-in `candidateSelection: 'knn'`, promote via the soak test. Verify sqlite-vec metadata-filter syntax FIRST at build time.
   Also (review note): verify worker-liveness `lastTickAt` staleness threshold tolerates legitimate `TokenBucket.acquire()` waits — busy-but-healthy must not read as stalled.
3. **Prod deploy discipline**: prod only runs tagged releases materialized from main via `reinstall`; branch-build pinning (`--dev` or hand-pointed `current.json`) gets a doctor WARN (exists) + this plan makes it a release-blocker checklist item.
4. **Ollama single-tenant policy** (until ONNX lands everywhere): never two embed models pinned; evals never share the prod Ollama instance (existing memory: no parallel evals on 8GB VRAM).
5. Owed follow-ups from the handoff: FEAT-506 orphan decision (`orphaned-local-main-feat506` @ 8278c6d), dual-pass LoCoMo full-suite revalidation, 0.20.0 promotion after soak.

## Key refs
- `docs/adr/ADR-018-onnx-embedding-provider.md`, `docs/adr/ADR-019-worker-isolation-recall-hang.md` (note: an earlier ADR-018 file covers worker isolation — two docs share the number)
- Handoff superseded by this one: `20260715T0800Z-handoff-beta-onnx-347-prod-deploy-blocker.md`
- Validation: `.claude/artifacts/crew/validations/20260715T000000Z-validation-onnx-embed-event-loop-block.md`
