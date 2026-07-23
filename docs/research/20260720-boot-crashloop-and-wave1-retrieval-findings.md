# 2026-07-20 — Boot crash-loop root-cause + Wave-1 retrieval findings

Two independent findings from the 2026-07-20 retrieval-overhaul session.

## 1. Daemon boot crash-loop on large encrypted DBs (prod incident)

### Trigger
Merging the retrieval-overhaul Wave-1 tracks (WT-B reranker, WT-C relations) touched
`migrations/` + `src/storage/`, which fired the **FEAT-439 post-merge git hook**
(auto `bun install && bun run build && reinstall`). The reinstall stopped the running
prod daemon and tried to deploy the merged build; its `verify-health` step failed at
90s and it rolled the pointer back to the prior release — dropping the daemon into a
crash-loop.

### Root cause (structural, pre-existing — the merge only exposed it)
On the affected box the prod DB is **573MB, SQLCipher-encrypted**. The daemon's boot
(`src/cli/serve.ts` `bootAndBind`) runs, in order:

```
openDb(573MB SQLCipher) → sqlite-vec extension load → provider/worker wiring
   (incl. a 2nd encrypted-DB open for the vec-search offload worker)
      → app.listen()   ← PORT BINDS HERE   → runMigrateAndDbSetup() → "serving on" log
```

FEAT-537 correctly defers **migrate** past the bind (non-strict path, `serve.ts:467-480`:
`buildApp → app.listen → runMigrateAndDbSetup`), so a slow migrate can't delay `/health`.
**But `openDb` + sqlite-vec load + provider/worker wiring all still run BEFORE `app.listen()`.**
Measured on the 573MB DB: that pre-bind span took **~6 min** (process start 14:31:41 →
first log line 14:37:53), and the phase is **low-CPU / high-wall = disk-I/O-bound, not
compute** — blocked reading the DB, badly amplified by ~25 concurrent node/eval processes
contending for disk. Total time to port-bind ≈ 8 min.

Meanwhile the **hang-watchdog** (`src/service/watchdog-probe.ts`,
`WATCHDOG_PROBE_INTERVAL_SEC=180`, `DEFAULT_FAILURE_THRESHOLD=2`) kills any daemon whose
`/health` fails 2 consecutive probes (~6 min). So the daemon is killed *while still
booting, before it ever binds* → restart from scratch → **permanent crash-loop**. The
design flaw:

> The watchdog cannot distinguish a **slow-booting** daemon (never bound yet) from a
> genuinely **hung** one (was healthy, now wedged). It must only kill the latter —
> killing a still-booting daemon just resets the slow boot and guarantees the loop.

The `reinstall` re-armed the watchdog, tipping a daemon that had run 7h stable into the
loop (the morning 06:00–06:33 crash-loop was the same mechanism). Ruled out: OOM
(8.5GB free), integrity_check at boot (only in backup/restore paths), openDb pragmas
(light: key/busy_timeout/WAL/foreign_keys/synchronous — no page_size/checkpoint/mmap
full-DB op), a competing daemon holding the lock (the only long-lived non-astramem node
was an Azure MCP server).

### Recovery applied
Disabled the watchdog (`Disable-ScheduledTask AstraMemoryDWatchdog`) → the prior-release
daemon completed its ~14-min boot and stayed up (pid served, `/health` ok). Prod restored
to the pre-merge release `0.20.0+0612da1`; the merged feature build was NOT deployed to
prod (never requested). Watchdog left disabled pending the boot-grace fix.

### Fixes (ranked)
1. **Watchdog boot-grace** (`watchdog-probe.ts`): only kill a daemon that was previously
   observed healthy this instance and is now unresponsive — never one that has never
   bound. Add a generous absolute boot hard-cap (~20 min) safety valve for a genuinely
   stuck-at-boot daemon. *In progress this session.*
2. **Extend FEAT-537 bind-first to cover `openDb`/vec-load/worker-wiring** — bind + answer
   `/health: starting` before the heavy DB open. Larger `serve.ts` change.
3. **Profile & shrink the ~6-min `openDb`** — likely sqlite-vec index load + the 2nd
   encrypted-DB open under disk contention. Consider lazy vec-load, VACUUM,
   checkpoint-on-shutdown. Needs a per-phase timing run on a DB copy to attribute exactly.
4. **`reinstall` verify-health tolerance** — its 90s `DEFAULT_HEALTH_TIMEOUT_MS` has the
   same blind spot; a 6-min boot never answers in 90s, so it always rolls back. Companion
   fix needed before the merged build can deploy to this box.
5. **Reduce boot-time box contention** (environmental — many concurrent agents/eval daemons).

### Also: FEAT-439 hook is dangerous
Auto-deploying a **feature-branch merge** to the live prod daemon turned a local
integration into a prod outage. The hook should be gated to release branches only, or
made opt-in.

## 2. Wave-1 retrieval results — fusion refuted, reranker is the only win

All A/B on the locked cheap recipe (conv-26 n=152, gpt-5-mini answerer + gpt-5-mini
llm-judge + token-F1). Wave-0 baseline: token-F1 0.4073 / llm-judge 0.4541.

| track | change | A/B result | verdict |
|---|---|---|---|
| **WT-B** P2 | local ONNX cross-encoder reranker (ms-marco-MiniLM-L-6-v2, in-process, offline) | **+0.0216 token-F1 / +0.0632 llm-judge** | ✅ merged `8b48ab04` — the only win |
| **WT-C** P6+P5 | atom-links (mig 056) + evidence provenance (mig 057), graph populated | ~flat (infra; retrieval doesn't consume graph until Wave-2 P4/P5) | ✅ merged `24610228` — infra only |
| **WT-A** P1+P3 | RRF fusion + deterministic multi-query | **RRF regresses** across every config (K=60/200, pool 75/50, 50/50 blend); multi-hop 0.28→0.15–0.21. P3 unmeasurable (`expand` request-body-only, harness never sets it) | ❌ reverted to no-op `618694e8` — nothing merged |

### RRF negative result (refutes the Codex "min-max→RRF" thesis on this corpus)
Every RRF config regressed token-F1, concentrated in multi-hop. Working theory: this
corpus's multi-hop/open-domain questions often have several atoms genuinely near-tied in
raw bm25/cosine magnitude (same entity/topic). Old per-pool **min-max** scores near-ties
*comparably*; pure ordinal **RRF** only sees which ranks first, not how close the runner-up
was — the opposite failure mode from the outlier-distortion RRF was meant to fix
(FEAT-480). The one near-parity lead was a 50/50 RRF+min-max blend (0.4024) — if fusion is
revisited, a *magnitude-cluster-gated* blend (rank-vs-magnitude keyed on how tightly a
pool's raw scores cluster) is the design lead, not a fixed ratio.

### Reranker double-down (2026-07-20, post-Wave-1) — tuned to plateau
Follow-up tuning of the one win (cheap recipe, conv-26 n=152, 5 passes):

| variant | token-F1 | llm-judge | multi-hop |
|---|---|---|---|
| rerank OFF | 0.3938 | 0.4075 | 0.2669 |
| onnx topK=50 (old default) | 0.4163 | 0.4811 | 0.2668 |
| **onnx topK=40 (NEW default)** | 0.4115 | **0.4907** | **0.2849** |
| onnx topK=100 | 0.3910 | 0.4683 | 0.2771 |
| bge-reranker-base topK=40 | 0.3870 | 0.3968 | 0.2218 |

`topK=40` is now the `defaultConfig()` default (best llm-judge + multi-hop; topK=100
regresses *below* rerank-off on token-F1 — wider ≠ better). A bigger model
(`bge-reranker-base`, ~11× the weights) is a clear LOSS on both metrics AND blew the
30s `/recall` handler deadline on 5/152 CPU-inference calls — registered as
evaluated-but-rejected, not enabled. `crossEncoder.enabled` stays `false` (flip is a
Gate decision). **Net: the reranker plateaus at ~+0.02 token-F1 / ~+0.07 llm-judge.**
Next reranker lever is evidence-excerpt scoring (rerank query+atom+**evidence**), inert
until `SearchHit.evidence` is populated in `search.ts` — a small cross-cutting follow-up.

### Strategic conclusion
The retrieval-**fusion** levers (RRF, FTS-OR-join from P0.2) are refuted one by one. The
**reranker** is the only lever that moved the number. Gate A did NOT clear its hoped
0.68–0.75 (only +0.06 from rerank). Operator decision 2026-07-20: **double down on the
reranker** (topK/model tuning, enable-default evidence) rather than push Wave-2 fusion or
graph work next. P3 multi-query is worth unblocking separately via a small config-driven
`expand` default in `src/server/routes/search.ts` (outside any Wave-1 track's scope).

### UPDATE (2026-07-20 later) — v3 re-ingest confirms the reranker is robust
Re-ingested conv-26 through the CURRENT pipeline → `20260720-baseline-v3-provenance`
(archived under `docs/eval-runs/`). **WT-C's pipeline validated end-to-end** (baseline-v2
had none of this): 309 atoms · `evidence_span` **94 (30%)** · `entity_relations` **22** ·
`memory_links` **1027** (all zero / columns absent on v2).

**Real-ONNX reranker A/B on v3** (same-path `ab-baseline`, retrieved-atoms×current, cheap
recipe): rerank-OFF llm-judge **0.5010** (F1 0.4553) → rerank-ONNX+evidence **0.5324**
(F1 0.4479) = **+0.031 llm-judge**. The real reranker HELPS on v3, confirming the v2 win
(+0.06) — **it is robust across stores.** Evidence-excerpt adds a small consistent +0.02
within rerank-on.

**FALSE-ALARM CAUTION:** an earlier v3 run via `run.mts` used
`crossEncoder.provider: 'mock'` (the Jaccard toy — `run.mts` has no `--rerank` flag; only
`oracle-factorial`/`ab-baseline` do), regressed, and produced a spurious "reranker not
robust" conclusion that was retracted. **Always confirm `provider: 'onnx'` in the
run-manifest before trusting a rerank A/B.** Net: the reranker (real ONNX) + evidence-excerpt
is a confirmed, robust win; enabling it by default is now evidence-backed (a Gate decision).

### UPDATE (2026-07-20 latest) — the "ingest-side lever" was extraction NOISE, not a lever
Chased the v3-rerank-off baseline (0.50) scoring higher than v2 (0.42–0.45). A cheap
same-store variance test (3 answer+judge runs on each FIXED store) showed the two stores
genuinely differ (v2 mean 0.423 / v3 mean 0.471, non-overlapping) — but that only proved the
two *extractions* differ, not that any pipeline change caused it. So ran a controlled
extraction A/B: re-ingest conv-26 **3× with the current prompt vs 3× with WT-C's `relations[]`
addition reverted**, rerank-off judge on all 6:

| variant | judge runs | mean | within-variant spread |
|---|---|---|---|
| current (relations[]) | 0.4534, 0.4605, 0.4972 | 0.4704 | 0.044 |
| reverted (no relations[]) | 0.4438, 0.4608, 0.4864 | 0.4637 | 0.043 |

**Between-prompt gap +0.007; within-variant extraction noise ±0.043 (6× larger).** VERDICT:
- **The `relations[]` prompt change is NOT a lever** (+0.007 = noise). Link-atoms (P6b) and
  evidence-span (P5) are logically ruled out too — side tables retrieval never reads at rerank-off.
- **DOMINANT FINDING: a single codex extraction of conv-26 swings the score ±4.3 llm-judge
  points regardless of prompt.** The original v2-vs-v3 "+0.048 gap" is inside that band — it was
  extraction LUCK (v2 a low draw, v3 a high draw), not a systematic ingest improvement.

**Methodological consequence (important):** single-conversation eval numbers are unreliable to
±4 pts — this explains the whole session's bouncing baselines (0.41–0.50). Only **same-store**
deltas are trustworthy at conv-26 scale (the reranker's +0.03 and evidence-excerpt's +0.02 hold
because they hold extraction fixed). Any A/B **across re-ingested stores** needs the FULL SUITE
(10 conversations averages the per-conversation noise) or 3+ extractions per variant. Do not quote
a single-extraction conv-26 ingest-side number as a lever again.

## Measurement protocol reminder
Every eval run (dev + all gates) uses the cheap stack. gpt-5.4 reader + CoT re-judge are
operator-approved-only, run by run — they do NOT auto-fire at gates. See
`docs/specs/20260720-retrieval-overhaul-plan.md` measurement section.
