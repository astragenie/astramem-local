# High-Priority Fix Plan

> **Date:** 2026-08-04 · **Baseline:** v0.22.0, schema 63
> **Inputs:** [constructive review](./review-2026-08-04-constructive.md) ·
> [adversarial review](./review-2026-08-04-adversarial.md) ·
> [remediation plan](./remediation-plan-2026-08-04.md) · measurements taken 2026-08-04
> **Scope:** the items rated critical or high only. Everything else stays in the remediation plan.

---

## Selection rule

An item is here if **any** of the following is true:

- it has already caused data loss or an outage
- it silently produces wrong information (worse than failing loudly)
- it blocks measuring whether something else is fixed

Everything else — however worthwhile — waits.

---

## Status of the critical set

| # | Item | Class | State |
|---|---|---|---|
| H1 | Cost cap blind to the default provider | data loss (occurred) | **built — PR #479** |
| H2 | Eval archive lost on worktree deletion | silent wrong info | **merged — #478** |
| H3 | `--dry-run-throughput` dropped pinned flags | silent wrong info | **merged — #480** |
| H4 | Unreproducible number defending a cost-doubling default | silent wrong info | **open** |
| H5 | Replaying a poisoned backlog burns its last attempts | data loss (occurred) | **open** |
| H6 | No trustworthy stability measurement exists | blocks verification | **open — needs 1 idle hour** |
| H7 | Evals co-located with production poison jobs | data loss (occurred) | **open** |
| H8 | Timing flakes make a red CI run uninformative | blocks verification | **open** |
| H9 | OFFSET pagination — the 10× breaker | outage risk (occurred at 1×) | **open** |
| H10 | Offload discipline unenforced | outage risk (3 occurrences) | **open** |

Three of ten are already closed today. The rest follow.

---

## Wave 1 — Close the loops that are already open (parallel)

These have no dependencies on each other and no dependency on a quiet box.

### H4 · Strike the unreproducible justification — **XS, do first**

`src/config/config.ts:1780-1789` and `:1043` justify `extractionPasses: 2` with
`0.4610 → 0.5549`. No archived run directory exists; the worktree was deleted. Measured today at
conv-1: **+0.0003 on categories 1–4**.

**Do:** replace the citation with the archived conv-1 pair and an explicit "full-suite
unverified" note. Also fix the adjacent claim that pass B is free *because extraction is local* —
extraction is `codex-subscription`, so that sentence is wrong today regardless of the score.

**Do not:** flip the default. conv-1 is not full-suite and cannot carry that decision.

**Done when:** no shipped default is defended by a number without a folder.

### H5 · Replay-loop circuit breaker — **S**

Requeue does not reset `attempts`, so a job at 3 gets exactly one more try. Replaying a backlog
against a still-degraded provider burns every remaining attempt in one pass.

> Today's 200-job replay succeeded **only** because it was hand-batched 5 → 45 → 50 → 100 with
> verification between batches. That discipline is operator knowledge, not code. One job still
> re-poisoned.

**Do:** abort the requeue loop after N consecutive same-class failures, reusing `classifyError`.
Report what was left un-replayed rather than silently stopping.

**Done when:** a simulated failing provider halts the replay with jobs still in reserve, proven by
a test that fails on today's code.

### H8 · De-flake the three timing tests — **M**

`shim.test.ts` (5 s bound), `detach.test.ts` (netstat race, since PR #159), `worker.test.ts`
concurrency (`expected 316 to be less than 300`). All wall-clock assertions on shared runners.

Individually re-runnable. Collectively they mean **a red CI run carries no information**, which is
how a real regression eventually gets waved through.

**Do:** replace wall-clock assertions with injected clocks or bounds wide enough to survive
contention; root-fix the netstat staleness race.

**Done when:** three consecutive full-suite runs are green under load.

---

## Wave 2 — Needs a quiet box (serial, one window)

**H6 and H7 share the same prerequisite and should be done in one sitting.**

1. Stop scheduling agents, evals and builds on this machine.
2. Let it settle ~10 minutes; confirm the daemon is idle and the pending queue drained.
3. **Replay the 4 poisoned jobs.** They sit at `attempts: 4` — one life each. They died to ONNX
   embed worker starvation during today's eval load, so replaying under load would burn that life
   for nothing.
4. **Take the stability measurement** in the same window: event-loop p99/max, timer drift, worker
   tick regularity, over ≥1 hour.

**Done when:** there is a documented event-loop profile taken with nothing else running — the first
one that exists — and the 4 jobs are recovered or definitively lost.

### H7's structural half

The measurement above is one-off. The **fix** is not running evals on the production box at all, or
gating them on daemon idleness. Today that co-location cost four sessions' memories, with the error
naming the mechanism outright: *"onnx embed timed out after 30000ms (worker thread busy or stuck)"*.

Also worth acting on: the soak monitor fired **seven times today, all false**, because it measures
`el_max` without regard to system load. A load gate (suppress above ~40% CPU) makes it a signal
again. A monitor that has been wrong seven times is worse than none — it trains you to ignore it.

---

## Wave 3 — Scale and enforcement (parallel, after Wave 1)

### H9 · Keyset pagination — **M**

`consolidate.ts::loadAtomsSetupBounded`. Migration 062 fixed the sort cost with a covering index
but explicitly did **not** fix OFFSET's O(offset) walk. **It already broke at 1×:** `el_max = 93 s`
in production on 2026-08-02.

**Do:** keyset (seek) pagination on `(repo, type, created_at, rowid)` — the 062 index already
supports it.

⚠️ **Verify on a populated DB, timed twice, on independently built datasets.** An empty-DB
`EXPLAIN` is precisely how migration 062 shipped broken: plan shape is identical at 0 rows and 90k
rows, while the per-row cost only exists at scale.

### H10 · Enforce the offload discipline — **M**

The pattern is right (KNN and embedding are offloaded to `worker_threads`); nothing protects it.
This class recurred three times and was caught by production incident every time, never by review.

**Do:** a lint rule or fitness function that fails the build when a synchronous DB or vector scan
becomes reachable from a request handler.

**Done when:** a deliberately-added synchronous scan in a route handler fails CI.

---

## Sequencing

```
Wave 1 ── H4 (XS) ─┐
          H5 (S) ──┼──→ Wave 3 ── H9 (keyset)
          H8 (M) ──┘              H10 (build rule)

Wave 2 ── [quiet box] ── H6 measurement + H7 replay
          (independent — can run any time work here stops)
```

Wave 2 is not on the critical path. It gates *verification*, not *fixes* — but until it happens,
"the daemon is stable" remains an assumption rather than a measurement.

---

## Explicitly deferred

Real, but not in this plan:

- **`LLMCallGovernor`** (five copy-pasted cap blocks) — high value, but no incident is waiting on
  it. Remediation plan P1-3.
- **Bedrock migration** — the Azure dependency has an expiry with no date, not an outage today.
  P1-4, five waves, planned separately.
- **α/β fusion ablation** — 80% of ranking weight, unvalidated. Important, not urgent.
- **`atomTriage` ship decision** — measured positive and zero-cost, parked. A decision, not work.

---

## What "done" looks like

When Waves 1–3 are complete:

- No shipped default is defended by a number that cannot be reproduced
- No bulk operation can silently exhaust its own retry budget
- A red CI run means something
- The known 10× breaker is fixed, verified against a populated database
- The discipline that prevents event-loop stalls is enforced by the build, not by memory
- There is at least one honest stability measurement on record
