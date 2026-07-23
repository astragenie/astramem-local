# Codebase refactor / consolidation / cleaning / performance plan (2026-07-23)

Synthesized from 3 search-subsystem researchers + 7 whole-codebase researchers (read-only static analysis, EXPLAIN QUERY PLAN against scratch :memory: DBs). Several findings were **independently cross-confirmed from two subsystems** (noted ⭐). Branch base: feat/retrieval-overhaul @ current tip.

## LoCoMo score note (read first)
This plan is **behavior-preserving by design → 0 target LoCoMo impact**. Performance items are latency, not answer quality (LoCoMo scores F1, not speed). The only score effect is **downside regression risk** on `search.ts`/`fuse.ts`/normalization touches — gated by ADR-005 floors + CONTRACT-FREEZE + full `retrieval-eval` (diff-only, prove-unchanged). Embed **batching** must be proven vector-identical to the per-text loop or it's a hidden retrieval change. This plan does NOT raise the score; score is #6 (multi-scope), a separate track.

---

## WS-1 · Shared-helper consolidation (biggest LOC + drift-risk win)
The repo has been repeatedly bitten by "fixed the bug in one copy, not the others." Each slice is re-export-backed (call sites unchanged), mostly with existing tests → "tests-still-green" review bar.

- **1a RunCapTracker ⭐** — the call-count/wall-clock cap tracker is copied 4× in distill (`GatekeeperRunTracker`/`AtomTriageRunTracker`/`DistillCostCapTracker`) + 2× in consolidate (`DupJudgeRunTracker` + contradiction-judge inline) + `groundAtomDates` inline. Identical fields/methods. → one `RunCapTracker({maxPerRun, maxWallClockMs, enabled?})`, existing classes become thin re-exports. **Single best ROI (cross-confirmed cb-distill + cb-pipeline).**
- **1b performSearch() ⭐** — the search-call flow (parse filters → validatePresetFilters → resolvePresetWeights → search() → recordRecallServed → shape) is duplicated **4× across REST+MCP** (`GET /search`, `POST /recall`, `search_memory`, `recall_memory`, ~250 lines). → one `performSearch()` helper. `filter-registry.ts` already solved the filter half.
- **1c http-retry** — `fetchWithRetry`/`combineSignals` copied 6× across LLM+embed providers → `providers/shared/http-retry.ts`.
- **1d guard-log factory** — 11 near-identical counter-log files (~750 LOC, self-documented "mirrors X field-for-field"): 7 simple-drop + 4 rate-log → 2 generic factories.
- **1e runDbBackedCheck** — 25 of ~50 doctor checks share identical DB-open/try/catch/inconclusive boilerplate → one wrapper in `shared.ts`.
- **1f applyEnumGovernance** — the "closed-enum gate, log+fallback" skeleton copied 10+× in config governance (numeric half already shared via `clampPositiveField`) → matching enum helper.
- **1g CLI/service boilerplate (trivial, do first)** — `parseArg` copied 18×, `hasFlag` 3× → `src/cli/arg-parse.ts`; `runCmd`/`RunCmdError`/`isInconclusiveFailure` tripled across schtasks/systemd/launchd → `src/service/exec-utils.ts`.
- **1h chunkedIn (incident-class)** — SQL `IN(...)` placeholder repeated ~24×, chunked in exactly one place after the 2026-07-15 SQLITE_MAX_VARIABLE incident; un-backported to `entities.ts` +sites → `chunkedIn()` helper.
- **1i misc** — MCP `textResult`/`errorResult` (45 raw constructions), `mapLifecycleError` for MCP (REST has it, tested; MCP re-derives 5×), worker-host base (`OnnxWorkerHost` ↔ `VecSearchWorkerHost`, preserve vec's fallbackChain), PID-identity (instance-lock ↔ reinstall), `sha256Hex`, fuzzy-match, `ensureJsonHint`, `requireExtendedCtxOrWarn`, `remember` REST/MCP dup, entity→memory-ids dup.

## WS-2 · Performance
- **2a missing-index migrations (one migration, hot-path value):** `idx_memories_project_valid_created` (pack.ts SessionStart scan — cross-confirmed cb-misc + perf), partial `idx_memory_events_unsynced WHERE synced_at IS NULL` (shipper scans every 30s on an append-only table), partial `idx_memories_needs_vec_index WHERE needs_vec_index=1` (every cleanup tick on the largest table).
- **2b quadratic / N+1 rewrites:** `loadAtomsSetupBounded` LIMIT/OFFSET paging with no ORDER-BY index → **re-scans+re-sorts the whole set per page (quadratic)** → `stmt.iterate()` single-sort (HIGH at scale; `setupBudgetMs` bounds the hang, not the cost). oversize-scanner `hasPendingOrRunningReembedJob` per candidate (up to 500 `SCAN jobs`/hourly tick) → one query + Set. entities/`get_entity_timeline` N+1 → batched `IN`.
- **2c embed batching:** Ollama & ONNX embed loop **per-text** (50-300 sequential round-trips per distill job); Azure batches correctly. ONNX chunked-batch (8-16) is the safe first target — **must prove vector-identical**. Ollama `/api/embed` (batch) is a version-gated spike (doctor embed-probe updates too).
- **2d concurrency adoption:** `mapWithConcurrency` (FEAT-487, exists) → `runGatekeeperSweep` / atom-triage Phase B / `groundAtomDates` (sequential today); parallelize the search fan-out (Promise.all + per-call `withAbortableTimeout`, reconcile in original array order — in the search plan).
- **2e deadline coverage:** `withDeadline` used only in search.ts + lifecycle.ts → add to MCP `search_memory`/`recall_memory` + `/dashboard/search` (can hang like pre-fix GET /search). `POST /mcp` rebuilds the whole ~20-tool MCP server per request (searchRoute hoists to boot) — check if the SDK requires it.

## WS-3 · Big-file splits (readability + collision-risk; repo already validated one-file-per-check on checks.ts 2167→split)
`config.ts` **2787** (→ domain schema slices + per-domain governance + thin barrel; `writer.ts` `configToYaml` 446L in lockstep) · `search.ts` 1349 (see the separate search-refactor plan: Phase 1 mechanical extract + re-export, Phase 2 careful fanout/explain reshape) · `mcp/server.ts` 1276 (by domain) · `prompts/extract.ts` 1263 (per-variant, **prompt-hash-freeze gated**) · `init.ts` 1108 · `ingest.ts` 1025 · `consolidate.ts` 1562 / `runConsolidation` ~500L · `05-extract` 862 (extract `atom-guards.ts`, fixes a cross-dir import smell) · `codex-subscription` 748 (extract `codex-auth.ts`).
**Defer (incident-dense — extract-function only, preserve comments, characterization tests first):** `serve.ts` ~900, `embedAndIndex` 1036, `memory-events` 725, `migrate` 353.

## WS-4 · Cleaning — reliability / observability / dead / doc-drift
- **4a (real observability gap):** **9 doctor checks (6 hardening + 3 gpu) never run unattended** — `schedule.ts` imports only from `checks.js`; the hardening/gpu factories are wired only into `cli/doctor.ts`. All cheap-tier (incl. "No poisoned jobs", "Instance lock healthy") → wire the cheap subset into `runFrequentDoctorChecks`.
- **4b (reliability):** embed `TransientError` never carries `retryAfterMs` (regression of the 2026-07-13 chunk-retry-amplification fix that LLM providers got) — one line ×2.
- **4c:** `dashboardSearchRoute` reads `defaultConfig().search` not the real config (the exact class search.ts documents fixing for GET/POST) + never resolves rerank/decompose/queryRewrite.
- **4d dead-code:** `EXTRACTION_STRICT_PROMPT` (built-wired-never-invoked → thread retry-attempt escalation or delete), `OnnxCrossEncoderProvider.preload()` (never called → wire into serve.ts boot or drop).
- **4e doc/config:** CLAUDE.md `KNOWN_THINKING_MODEL_PREFIXES` citation is stale (constant doesn't exist; actual guard is stronger/model-agnostic); `pricing.ts` placeholder → gpt-5* silently costs $0; unify `loadConfig`/`loadConfigFromDisk` governance chains (drifted twice; `loadConfig` has zero prod callers → collapse or delete). `checks/index.ts` stray `// P2.1 stabilization` merge-note comment.

## Cross-cutting constraints
- **Prompt-hash-freeze test** gates extraction-prompt consolidation → compose identical strings from fragments (prove hash unchanged); don't trigger the re-baseline ceremony.
- **CONTRACT-FREEZE §2 + ADR-005 floors** gate search.ts + fusion → diff-only review + full retrieval-eval + contract-conformance.
- **Don't merge the intentional dups:** search.ts debug/explain (byte-identical guarantee), the WS6 vs FEAT-550 fan-out dedup-semantics diff — share only the shell.
- **Incident-dense files** (serve.ts, embedAndIndex, memory-events, migrate, consolidate) — extract-function only, preserve every ordering comment, characterization tests first.
- Re-export **barrels** keep 40+/N call sites unchanged → most WS-1/WS-3 slices review at "tests still green."
- All work is local + PR + CI; **no prod touch**; FEAT-439 hook stays gated/off through merges.

## Recommended sequencing
- **Immediate wins (~2-4d, small/safe/real):** 2a indexes · 1g CLI/service boilerplate · 1a RunCapTracker · 4b embed retry · 4a wire-9-checks · 2b oversize+timeline N+1.
- **Next:** 1b performSearch · 1c http-retry · 2c embed batching (vector-identical proof) · 2e deadlines · 2b loadAtoms iterate.
- **Then (own reviewed PRs):** WS-3 splits — config.ts, search.ts, mcp/server.ts.
- **Ongoing:** remaining WS-1 helpers + WS-4 doc corrections.
