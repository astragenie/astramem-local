# Remediation Plan — 2026-08-04

> **Inputs:** [`review-2026-08-04-constructive.md`](./review-2026-08-04-constructive.md),
> [`review-2026-08-04-adversarial.md`](./review-2026-08-04-adversarial.md), and Sheet 08 of
> [`astramem-architecture-sheets.md`](./astramem-architecture-sheets.md).
> **Baseline:** v0.22.0, schema 63.
> **Framing:** neither review recommends a rewrite. Both converged independently on the same two
> blockers. Everything here fits inside the current architecture.

---

## The two things both reviewers found independently

1. **`budget.daily_usd` is structurally blind to the shipped default provider.** Already caused
   silent data loss (198 poisoned jobs, ~875 memories, 2026-07-31).
2. **The "offload heavy work to a worker_thread" discipline is real but unenforced.** Recurred
   three times; caught by production incident every time, never by review.

When two independent reviewers with opposite briefs land on the same two items, those are the two
items.

---

## P0 — blocks shipping wider

### P0-1 · Consecutive-429 circuit breaker for `codex-subscription`

**Problem.** `codex-subscription.ts:779` and `ollama.ts:302` hardcode `usage.usd: 0`, which is the
field `BudgetTracker.assertCanSpend` reads. The $10 default cap cannot fire for the default
provider. Dollar-capping a subscription quota is impossible by construction, so the cap can never
be made to work as designed.

**Fix.** Not a dollar cap — a **provider-error-signal breaker**. Trip after N consecutive
`usage_limit_reached` / 429 responses; pause the affected job class rather than letting it burn
attempts. The signal (`usage_limit_reached`), the classifier (`classifyError`) and the backoff
plumbing (`retry-after.ts`) all already exist. This is wiring.

**Also required:** `contradictionDetection` already proves a call-count/wall-clock cap is possible
here. Reuse that shape (see P1-3).

**Done when:** a simulated 429 storm pauses distill instead of poisoning it, proven by a test that
fails on today's code.

**Effort:** small–medium. **Risk if skipped:** every customer accepting the default install
inherits an unmetered quota cliff with a demonstrated silent-failure history.

---

### P0-2 · Re-run and archive the dual-pass eval

**Problem.** `extractionPasses: 2` ships as default and roughly doubles metered calls, justified in
`config.ts:1780-1789` by *"0.4610 → 0.5549"* — a figure with **no archived run folder**, which by
`docs/eval-runs/README.md:7` makes it unverified.

**Important context, and it changes the remedy.** The operator recalls this run directly: it was
executed in a **git worktree that was later deleted**, which is why nothing survived. This is
corroborated — the tracker records the 0.6002 champion as *"run dir deleted"* too. So the
measurement was almost certainly performed and almost certainly showed a gain. **What is missing is
the evidence, not the work.**

**Therefore: do not revert to single-pass on suspicion.** That would discard a probably-real
improvement over a bookkeeping gap.

**Fix.**
1. Re-run dual-pass on the **provider that actually ships** (`codex-subscription`, not the local
   qwen the original run used), with a **same-day single-pass control** — mandatory, given proven
   ±6-point day variance.
2. Archive both legs under `docs/eval-runs/<date>-dual-pass-full-suite/`.
3. Correct the `config.ts` comment regardless of outcome: it argues pass B is free *because
   extraction is local*, and extraction is **not** local. That sentence is wrong today independent
   of the score.

**Done when:** a canonical archived folder exists with both legs, and the comment matches reality.

**Effort:** medium (eval wall-clock, not engineering). **Risk if skipped:** a permanent 2× cost
default defended by a number that cannot be produced on request.

### ⛔ Costing result (2026-08-04) — full-suite is NOT currently affordable

A costing pass produced a **no-go for an immediate full-suite run**:

| | codex-subscription calls |
|---|---|
| Leg B — single-pass | ~272–350 |
| Leg A — dual-pass, faithful (`--passb-sweep untuned`) | ~544–700 |
| **Both legs, same day** | **~820–1050** |

**Anchor:** the 2026-07-31 quota exhaustion tripped at **~322 HTTP 429s / 55 poisoned jobs** — the
only real data point this repo has for what exhausts a ChatGPT Plus quota in one burst. The
two-leg run needs roughly **3× that**. With no circuit breaker yet (P0-1), a 429 storm mid-run
would retry-and-poison rather than stop cleanly — repeating the exact incident this plan exists to
prevent.

**Revised sequencing for P0-2:**

1. **P0-1 and P0-3 must land first.** Both are hard prerequisites, not parallel work.
2. **Calibrate** with `--dry-run-throughput --dry-run-conversations 1` (no answerer, no judge, no
   Azure call) to replace the estimated chunk count with a measured one. The ~272–350 figure is
   *inferred* — no archived run records an actual full-suite chunk count.
3. **Cheap directional check** at conv-1 scale, same-day dual-vs-single. Cannot restore the
   0.4610→0.5549 claim (scales are not comparable) but does confirm the effect still exists on
   codex today.
4. **Full-suite pair only with confirmed quota headroom** — ideally a fresh billing cycle — using
   `--shards` and `run.mts --resume` so a 429 burst can be caught and resumed rather than left to
   poison jobs unattended.

### Two fidelity traps found while costing

- **`--passb-sweep untuned` is required for faithful replication.**
  `EXTRACTION_PASS_B_DEFAULTS` (the skip-gate, `sweepOnlyBelowAtoms: 8`, and the 1500-token cap)
  was added **four days after** 0.5549 was measured. Omitting the flag silently answers a
  different, cheaper question — today's gated dual-pass, not the configuration the `config.ts`
  comment cites.
- **The re-run is not a clean replication, by design.** The original ran on local qwen; this runs
  on `codex-subscription`. That is deliberate — it measures the more decision-relevant question
  ("does dual-pass help on the provider that actually ships") — but the resulting number must not
  be presented as a reproduction of 0.5549. It is a new measurement.

The harness has **no paired/interleaved run mode**; same-wall-clock-day back-to-back invocations
are the only available variance control.

---

### P0-3 · Guard against unarchived eval runs

**Problem.** Two headline numbers have now been lost to deleted worktrees (0.5549 and 0.6002). This
is a repeating, expensive failure of process, not of judgment.

**Fix.** Make archiving happen outside the worktree, or refuse to report a score that has not been
written to `docs/eval-runs/`. Cheapest useful version: the harness writes its archive to an
absolute path outside the working tree, and prints the archive location with the score.

**Done when:** a run executed inside a throwaway worktree still leaves an archived folder after the
worktree is destroyed.

**Effort:** small. **Risk if skipped:** it happens a third time.

---

## P1 — do before the next release

### P1-1 · Circuit-break poisoned-job replay

Requeue does not reset `attempts`, so replaying a backlog against a still-failing provider burns
every remaining attempt in one pass.

> Confirmed live 2026-08-04: replaying 200 poisoned jobs succeeded **only** because it was
> hand-batched (5 → 45 → 50 → 100) with verification between batches. That discipline is currently
> operator knowledge, not code.

**Fix.** Abort the requeue loop after N consecutive same-class failures, using existing
`classifyError` output. **Effort:** small.

---

### P1-2 · Keyset pagination for `loadAtomsSetupBounded`

The first thing that breaks at 10×, and it already broke at 1×. Migration `062` fixed the sort cost
with a covering index but explicitly did **not** fix OFFSET's O(offset) walk — its own comment says
so, and it is already tracked for 0.22.1.

At ~1M rows the tail pages walk and discard ~1M index entries each, on the exact path that produced
`el_max=93s` on 2026-08-02.

**Fix.** Keyset (seek) pagination on `(repo, type, created_at, rowid)` — the covering index from
062 already supports it. **Verify on a populated DB, timed twice** — an empty-DB EXPLAIN is what
caused 062's original miss. **Effort:** medium.

---

### P1-3 · Extract one shared `LLMCallGovernor`

Five hand-written `{mode, maxPerRun, maxWallClockMs}` blocks in `config.ts` —
contradictionDetection, dupJudge, extractionPassB, atomTriage, gatekeeper — each with its own
normalizer, each repeating `maxPerRun: 200, maxWallClockMs: 300_000`.

This is the FEAT-482 incident's fix, reproduced by hand five times. **Every new LLM-gated stage is
one omitted copy-paste from repeating that incident.** Extracting it also gives P0-1 somewhere
natural to live. **Effort:** medium.

---

## P2 — track, schedule deliberately

| # | Item | Why | Effort |
|---|---|---|---|
| P2-1 | Enforce the offload discipline | A lint/fitness rule failing the build on new synchronous DB or vector scans reachable from a request handler. The pattern is right; nothing protects it. | Medium |
| P2-2 | Wire or drop `byo-presets` capability flags | `byo-presets.ts:98-105` flags Gemini JSON mode `'partial'`; `openai-compatible.ts` sends bare `json_object` anyway. Built, wired, never invoked. Either branch on it or keep only the coarse tested/untested distinction. | Small |
| P2-3 | Ablate the base fusion weights | α (BM25 0.4) and β (cosine 0.4) are **80% of ranking weight** and are policy-exempt from the eval-evidence rule ADR-014 enforces on every smaller term. | Medium |
| P2-4 | Decide `atomTriage` ship status | Measured **positive and zero-cost** (recall 80.1, typeAcc +9) and still `off`. The bar for shipping is currently inversely correlated with cost — the free win waits, the expensive one shipped. | Small (decision) |
| P2-5 | Give full-corpus scans the KNN worker_thread treatment | Indexes buy headroom; they don't cap worst-case blocking. | Medium |
| P2-6 | Collapse 5 guard-drop-counter modules | Same shape repeated five times. | Small |

---

## Demo blockers — separate track, product decisions

From Sheet 08. These are not architecture defects; they are things a customer hits on day one.

| Item | Impact | Owner |
|---|---|---|
| Codex is the default and needs `codex login` + a paid plan | First distill fails on a clean customer box | Product |
| `sync.experimental` must be hand-edited in `config.yaml` | `pair` never sets it — sync silently does nothing after a successful pair | Small fix |
| Dashboard bearer-cookie path never exercised locally | Dev box bypasses auth via `dev-no-auth`; the real customer flow is untested | Small |
| Capture + memory-pack hook default OFF | Accept-all-defaults install captures nothing | Product |
| BYO presets never live-fire tested | Four advertised providers verified against vendor docs only | Medium |

---

## Sequencing

```
P0-3 (archive guard)  ──┐
                        ├─→ P0-2 (re-run dual-pass, archived properly)
P0-1 (429 breaker)  ────┘
        │
        └─→ P1-3 (LLMCallGovernor — gives P0-1 a home)
                │
                └─→ P1-1 (replay breaker) ──→ P1-2 (keyset pagination)
```

**P0-3 comes before P0-2** — re-running the eval without fixing the archive guard risks losing the
evidence a third time.

---

## Explicitly not doing

- **A rewrite.** Settled by the 2026-07 teardown; both reviewers reaffirmed it independently.
- **Reverting `extractionPasses` to 1.** The evidence is missing, not the improvement. Re-measure
  first (P0-2).
- **A simpler index instead of the LLM pipeline.** Already tested and killed with data —
  raw-transcript search measured F1 0.137.
- **Swapping SQLite.** Already adjudicated: the store is 1–3% of the latency path.
- **A full HTTP/worker process split.** Trades one moving part for two with no scale win at
  today's usage.
