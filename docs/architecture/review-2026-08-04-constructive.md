# Architecture Review — Constructive Pass

> **Subject:** astramem-local v0.22.0, schema 63
> **Reviewed:** `docs/architecture/astramem-architecture-sheets.md`, cross-checked against `src/`
> **Date:** 2026-08-04
> **Posture:** salvage-not-rewrite is settled (2026-07 teardown). Every recommendation stays
> inside the current process and module shape.
> **Companion:** [`review-2026-08-04-adversarial.md`](./review-2026-08-04-adversarial.md)

---

## Top recommendations, ranked by impact / effort

| # | Recommendation | Impact | Effort | Where |
|---|---|---|---|---|
| 1 | Replace consolidate's OFFSET pagination with keyset pagination | High | Medium | `src/consolidate/consolidate.ts::loadAtomsSetupBounded` (~1089–1116); migration `062` |
| 2 | Circuit-break poisoned-job requeue on repeat same-class failure | High | Small | `src/pipeline/worker.ts:13`; `src/pipeline/failure-classifier.ts` |
| 3 | Replace the codex budget gate with a 429/quota circuit breaker | High | Small–Medium | `src/providers/llm/codex-subscription.ts:779`; `src/budget/tracker.ts` |
| 4 | Extract one shared `LLMCallGovernor` to replace 5 hand-copied cap blocks | High | Medium | `src/config/config.ts` (5 sites, listed below) |
| 5 | Wire `byo-presets.ts` capability flags into request building | Medium | Small | `src/providers/llm/openai-compatible.ts`, `byo-presets.ts` |
| 6 | Give full-corpus scans the `worker_thread` offload KNN already has | Medium–High | Medium | `src/consolidate/consolidate.ts` |
| 7 | Collapse 5 near-identical guard-drop-counter modules into one writer | Low–Medium | Small | `src/storage/{relation,entity,evidence}-guard-log.ts`, etc. |

---

## 1 · Service boundaries

**The daemon is not doing too much for what it is — but its internal thread discipline is
inconsistent, and that already caused an incident.**

`src/server/app.ts` wires ~20 route modules into one Fastify instance, and `src/cli/serve.ts`
starts the job worker in the same process on one `better-sqlite3` handle. Worker concurrency
(default 2 lanes) is deliberately **cooperative, not parallel** — the correctness comment at
`worker.ts:78–91` states claim-safety relies on Node being single-threaded. That is also the
availability liability: any synchronous DB-bound work blocks the HTTP event loop, dashboard
included.

The inconsistency is the finding. KNN search is already offloaded to a `worker_thread` — correct
for a hot synchronous path. But migration `062`'s own comment records that consolidate's page scan
ran *synchronously on the main thread* and hit `el_max=93s and climbing` in production on
2026-08-02. One heavy scan got the safe treatment; the other didn't, until it stalled the daemon.

**Boundaries that are already right — do not re-litigate:** the LLM proxy (`:7778`) is a separate
CLI process that writes to the ingest spool on disk rather than calling the daemon over HTTP —
decoupled by a durable queue, not a live RPC. `mcp-stdio` has zero daemon dependency.

**What not to extract:** a full HTTP/worker process split. For a local single-tenant daemon that
trades one moving part for two with no scale win at today's usage.

**What to extract (narrow):** give consolidate's scan the same `worker_thread` treatment KNN has.
Indexes buy headroom; they do not cap worst-case blocking.

---

## 2 · The distillation pipeline

**Sequencing is correct where checked. The real question is duplication, not ordering.**

- Gatekeeper (3b) sits between chunk and compact — the cheapest place to drop noise before paying
  for compact + extract. Correct position.
- Pass B already has its duplication mitigation: `sweepOnlyBelowAtoms` skips chunks pass A covered
  well. That lever is pulled.
- **Open duplication question:** for a chunk that is compacted, three LLM round-trips run serially
  per lane (compact → extract → extract-specifics), and extract's only input is compact's output.
  Whether compact and extract could merge into one structured-output call is an **eval question**,
  not a code change to make blind.

**Is shipping gatekeeper / evidence-gate / atom-triage OFF the right posture?** Yes, with a
caveat. All three are LLM-in-the-loop filters, and this repo has a live incident (FEAT-482:
contradiction detection shipped `enabled` with no call cap → 245 sequential calls against a
metered endpoint). Given that the shipped default provider structurally cannot be dollar-capped
(§3), enabling a third or fourth always-on LLM filter before that gap closes would compound an
existing blind spot.

*Confidence: medium that OFF is operationally correct; low on the retrieval-quality tradeoff —
gate-specific precision/recall numbers in `docs/eval-runs/` were not checked.*

---

## 3 · Failure and recovery

**Batch-level replay is the silent-loss risk.** Requeue does not reset attempts, so a poisoned job
replayed while the provider is still degraded gets exactly one more try before repoisoning. A bulk
replay against a still-failing provider burns the entire backlog's remaining attempt budget in one
shot, with nothing to stop it mid-batch.

> Confirmed live on 2026-08-04: the 2026-07-31 codex quota exhaustion poisoned 198 distill jobs.
> Replay succeeded only because it was hand-batched (5 → 45 → 50 → 100) with verification between
> batches. **That discipline is currently operator knowledge, not code.**

Recommendation: a replay-time circuit breaker keyed on existing `classifyError` output — abort the
requeue loop after N consecutive same-class failures.

**Budget-pause-not-fail** (`worker.ts:225–226`) is good design: it avoids burning a job's attempt
budget on a cap breach. No issue.

**Wide fail-open** is loud in aggregate — guard-drop counters feed rate-based doctor canaries,
which is the right pattern given this repo's hard-won lesson that an *existence* canary once hid an
87%-broken entity extractor for weeks. But it is silent per-event, and nothing *enforces* that a
new fail-open path ships with a matching rate canary. It is a convention across five hand-rolled
modules, not a checked invariant.

### The single highest-blast-radius gap

`budget.daily_usd` (default $10) **cannot fire for the shipped default provider.** Verified:
`codex-subscription.ts:779` and `ollama.ts:302` both hardcode `usage: {usd: 0}`, and
`BudgetTracker.assertCanSpend` reads that field. The cap is structurally decorative.

Since dollar-capping a subscription quota is impossible, the fix is a **call-rate / consecutive-429
circuit breaker** specific to codex-subscription. The error signal (`usage_limit_reached`) and the
backoff plumbing (`retry-after.ts`, `classifyError`) already exist. This is wiring, not new
infrastructure.

---

## 4 · The provider abstraction

**The seam is right for OpenAI-compatible vendors and slightly overstates itself for anything
else.**

"5 providers + 4 presets" blends two abstraction levels. The four BYO presets are genuinely just
**data** — `{baseUrl, defaultModel, apiKeyEnv, capabilities}` through one adapter. Adding an
eleventh OpenAI-compatible vendor is a config-object addition. But `ollama`, `anthropic`,
`azure-openai`, `codex-subscription` and `openai-compatible` are five hand-written adapters for
structurally different wire formats. A tenth provider that *isn't* OpenAI-compatible needs a new
adapter file. That is an honest limit, not a defect — but "10th provider" has two very different
costs depending on which kind it is.

**Verified drift:** `byo-presets.ts:98–105` flags Gemini's JSON mode as `'partial'`, but
`openai-compatible.ts` sends bare `json_object` regardless. The capability data exists, is useful,
and is not wired to adapter behaviour — the "built, wired, never invoked" pattern this repo already
has a name for. The same file states outright: *"None of these were live-fire tested against a real
API key."*

Either make `jsonObjectMode` / `maxTokensParam` load-bearing, or drop the fine-grained flags and
keep only the coarser field-tested / not-tested distinction.

**Well-seamed, keep it:** role-specific provider overrides (`extractionPassB.provider`,
`atomTriage.provider`, `gatekeeper.provider`) let a cheap local model run frequent narrow calls
while a stronger model runs extraction, with zero new code per combination.

---

## 5 · Scale — the first thing that breaks at 10x

Grounded in something that **already happened at 1x**, not projection.

Migration `062` records: at ~94.5k rows, `loadAtomsSetupBounded` — a synchronous main-thread
`SELECT … JOIN memories_vec … ORDER BY repo, type, created_at, rowid LIMIT ? OFFSET ?` paging
through ~190 pages — hit `el_max=93s and climbing` in production. A covering index fixed the sort
cost.

**Still open, per the migration's own comment:** OFFSET's O(offset) row-skip was explicitly *not*
fixed — *"SQLite still walks and discards `offset` index entries per page"* — tracked as a 0.22.1
follow-up. At ~1M rows the tail pages would walk and discard up to ~1M index entries per page, on
the exact code path that already caused a 93-second stall.

**Answer: `consolidate.ts::loadAtomsSetupBounded`'s OFFSET pagination.** Not hypothetical.

Explicitly *not* verified, flagged rather than guessed:

- Whether any other full-corpus scan is safe at 10x. This repo's standing lesson is that an EXPLAIN
  on a near-empty DB looks identical to one on a populated DB — that is exactly how migration 062
  was missed. No populated 10x DB was available.
- `memories_vec` re-embed at 1M rows: a 10x-longer resumable `reembed-dim` pass. Batch size and
  resumability under a multi-hour run unchecked.
- WAL checkpoint behaviour on a ~10 GB SQLCipher file under the existing 1h timer. Unmeasured.

---

## 6 · What is missing entirely

**A shared LLM-call governance primitive.** Five independently hand-written
`{mode, maxPerRun, maxWallClockMs}` cap blocks live in `config.ts` — contradictionDetection,
dupJudge, extractionPassB, atomTriage, gatekeeper — each with its own normalization function, each
literally repeating `maxPerRun: 200, maxWallClockMs: 300_000`. This is the FEAT-482 incident's fix
pattern, reproduced by hand five times instead of extracted once. Every new LLM-gated stage is one
omitted copy-paste away from repeating that incident.

**A provider-error-signal circuit breaker**, distinct from the call-count caps above. Those bound
*how much work we attempt*, not *stop attempting once the provider is clearly failing*. Different
failure mode; only the first is covered anywhere.

**Per-route rate limiting on the HTTP API.** Low severity for a local single-user daemon — but the
proxy forwards agent traffic to a metered upstream on every request with no visible throttle. If
that is an intentional "trust the local caller" choice, it should be stated as one.

### Confirmed *not* missing

Ruled out with confidence: backup/restore exists (`src/backup/`); rate-based doctor canaries are a
deliberate ADR-015 pattern; partial-index scale hygiene is repeated practice (migrations 045, 059,
061, 062).
