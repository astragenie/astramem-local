# Stability Remediation — Wave Execution Plan

*2026-07-13 · Executes `docs/specs/20260713-teardown-remediation-plan.md` (architect + architect-reviewer signed off) + issue #205.*

---

## Three hard constraints

### 1. NO OLLAMA DURING DEV. Not once.

Ollama is **one shared GPU** on a box that also runs the **production daemon**, eval shards, and sibling agents. It has already been oversubscribed today with measured consequences:

> Four concurrent LLM-dependent agents took embed latency from **37ms → 48s**, poisoned **24 production distill jobs** (31 → 55 poison count), and produced **one garbage eval run**.

**Every dev worktree runs with `ASTRA_MEMORY_MOCK_PROVIDERS=1`.** Verified real — the test suite and `src/cli/demo.ts` already use it, and `serve` / `mcp-stdio` both honor it. There is no need for a real model to build or unit-test any slice in this plan.

**The only phase permitted to touch a real model is Wave D (E2E), and it runs alone, serialized, after everything else has merged.**

### 2. NO WORKTREE TOUCHES THE PRODUCTION DATADIR

The default datadir **is production**. A worktree with its own branch and `dist/` but *not* its own datadir is how an uncommitted migration reached prod and took the daemon down today (#187, guarded in #194).

**Every worktree exports, without exception:**
```bash
export ASTRA_MEMORY_ISOLATED=1          # skips config.yaml/sync.json merge, force-disables sync
export ASTRA_MEMORY_MOCK_PROVIDERS=1    # no Ollama, no GPU
export ASTRA_MEMORY_DATADIR="$PWD/.dev-datadir"
export ASTRA_MEMORY_TOKEN=devtok        # never touch the OS keystore (FEAT-466: it is NOT datadir-scoped)
# port: unique per worktree, see table
```
Never run `serve`/`doctor`/`reinstall`/`init`/`migrate` without these. **`ASTRA_ALLOW_PROD_DATADIR=1` is forbidden in every wave of this plan.**

### 3. FILE-DISJOINT OR IT DOESN'T SHIP IN PARALLEL

Waves are cut on **file ownership**, not topic. Two agents in one file is the one reliable way to manufacture a conflict — and today a `git add -A` in a shared checkout **swept up another agent's docs and silently reverted a correction.**

---

## WAVE A — four worktrees, fully parallel, zero Ollama

| Slice | Worktree / branch | Owns (exclusive) | Port |
|---|---|---|---|
| **A1** — PID-identity check | `wt-a1-pidlock` / `fix/pid-identity-check` | `src/service/instance-lock.ts` | 7801 |
| **A2** — zero-yield telemetry + doctor | `wt-a2-loudfail` / `feat/zero-yield-telemetry` | `migrations/032-*.sql`, `src/doctor/**`, `src/distill/stages/08-embed-index.ts` | 7802 |
| **A3** — redact at spool-write | `wt-a3-redact` / `fix/redact-at-spool-write` | `src/capture/proxy.ts`, `src/ingest/spool*.ts`, `src/redact/**` | 7803 |
| **A4** — atom-level validity (#205) | `wt-a4-validity` / `feat/atom-validity-interval` | `src/distill/prompts/extract.ts`, `src/storage/memories.ts` | 7804 |

**Disjointness audit** (do not skip this when adding a slice): A2 and A4 both live under `src/distill/`, but in **different files** (`stages/08-embed-index.ts` vs `prompts/extract.ts`). A2 owns `migrations/`; **nothing else in Wave A may add a migration.** A4 touches `storage/memories.ts`; A2's telemetry must land in its **own** repo module, not in `memories.ts`.

### A1 — PID-identity check *(ships first; the only finding that can destroy things while we work)*

`stopLockHolder` verifies a `daemon.lock` PID is **alive**, never that it is **the daemon**, then signals it (Windows: unconditional force-kill). Fires from a **≤3-minute watchdog timer** and from **four** call sites — `watchdog-probe.ts`, `reinstall.ts` (×3), **and `src/cli/service.ts` (`service stop`)**, the fourth found by review and the one a human actually types.

**Fix at the `stopLockHolder` implementation, not at the callers** — that covers all four by construction.

Stamp process **start-time** in the lock at acquire; refuse to signal unless PID **and** start-time match. Cross-platform: `/proc/<pid>/stat` field 22 (Linux); PowerShell `Get-CimInstance` on Windows — **not `wmic`** (deprecated/removed on current builds). **Fail closed if the identity check itself errors**, not only on a confirmed mismatch.

**Acceptance — BOTH directions, or you ship a watchdog that never kills anything:**
- Forged lock, real PID, **mismatched** start-time → **refuses to signal.**
- Genuinely wedged daemon, **matching** start-time → **still killed.** *(Without this test, an implementation bug silently converts "don't kill the wrong process" into "don't kill anything," neutering the hang-watchdog with no alarm — and the plan would call it a pass.)*

### A2 — zero-yield telemetry + doctor *(the invariant, made enforceable)*

A distill job whose model returns a well-formed `{"atoms":[]}` **completes successfully.** A broken model and a quiet week are the same observable state.

- New `extraction_yield` table — **copy the `relation_guard_drops` (migration 029) + `checkEntityRelations` pattern.** It already solves "is this zero real or broken" for relations; generalize it, don't reinvent it.
- **ADR-015 rule 6 — state the denominator.** Not "N atoms produced." **"K of N transcripts produced zero atoms."** A canary that can only go green is decoration.
- Reuse `MEANINGFUL_USAGE_THRESHOLD` gating — alarm on a **rolling rate**, never a single zero (a genuinely empty session is normal).
- `checkMemoryHealth` gains a real **`ok:false`** branch (it is currently hardcoded `ok:true` — a 100% poison rate reports OK).
- `serve.ts` schedules `runChecks` — **but split the cadence**: cheap DB checks frequent; **`llmChatProbe` makes a real LLM call**, so it piggybacks the existing 24h tick. A tight interval here is a self-DoS, and on a metered endpoint it is the FEAT-482 incident class.
- **Migration + write site + doctor read land in ONE PR.** No fifth orphan table.

### A3 — redact at spool-write

Proxy transcripts spool to disk **plaintext**; parse failures quarantine **before** redaction (`spool-drain`), with no TTL, no canary, weaker perms than the keystore. **The selection effect is the danger: content that breaks a parser is disproportionately content containing secrets.**

**Redact at spool-write, for everything** — the "it costs proxy latency" objection is **false**: capture already runs in a `setImmediate` *after* the client response completes (ADR-013 Decision 3), so a redaction pass there cannot slow a single request. Plus: `.quarantine/` TTL, keystore-grade perms, doctor canary on depth/age.

### A4 — atom-level validity (#205)

`AtomSchema` has no atom-level `valid_at`/`invalid_at`; `InsertInput` has no `valid_to`. Storage and `as_of` retrieval are **both already correct** — nothing populates them.

**Decide the `NULL` semantics before writing code** (permanent mixed store; a backfill is impossible): is `valid_to IS NULL` *"valid forever"* (current, defensible) or *"unknown"*? Write the answer into the migration and `CLAUDE.md`.

**Expect zero LoCoMo movement. That is success, not failure** — the harness never sets `as_of`. This is a product fix, not a score fix.

---

## WAVE B — serialized, after Wave A merges

| Slice | Why it cannot run in Wave A |
|---|---|
| **B1** — drop `messages`, `artifacts`, `provider_state` | **Collides with A2 on `migrations/`.** And it is an **irreversible DROP** — `reinstall --rollback` repoints *code*, not schema. |
| **B2** — `service stop` regression test | Depends on A1's identity check existing. |

**B1 safety gate — non-negotiable.** Before the DROP: run `SELECT COUNT(*)` on all three tables **against the real production DB** (read-only; do **not** run `migrate()`). Git history proves *this repo* never wrote them — it does **not** prove a prior version, a hand-run script, the SaaS sync client, or the plugin never did. **A non-zero count halts the drop.** Also remove the dashboard's dead read of `provider_state` (`queryProviders`) in the same PR, or you ship a query against a table that no longer exists.

---

## WAVE C — merge + integration, still no Ollama

Merge A1–A4 + B to `main` in dependency order. Full `bun run build` + `vitest run` **with `ASTRA_MEMORY_MOCK_PROVIDERS=1`** — the entire suite passes without a model. Confirm `doctor` goes **red** on a simulated broken extractor and **green** on a genuinely contentless one. *(That distinction is the whole point of A2; if you can't demonstrate it, A2 didn't land.)*

---

## WAVE D — E2E. Last phase. The ONLY phase that touches Ollama.

**Runs alone. Nothing else executing on the box. One model-dependent process at a time.**

| Step | What | Ollama |
|---|---|---|
| **D1** | Real-daemon smoke: `init` → `serve` → ingest → distill → recall, on an **isolated datadir**, real `qwen3:8b` + `mxbai-embed-large` | ✅ serial |
| **D2** | **Kill-path E2E** — the one that cannot be mocked. SIGKILL the daemon (leaving a stale lock), recycle the PID, run `service stop` and the watchdog. **Assert the innocent process survives.** This is A1's whole reason to exist and a unit test cannot prove it. | ✅ serial |
| **D3** | **Loud-failure E2E** — point extraction at a deliberately broken model. Assert `doctor` goes **red unattended**, and that a genuinely empty transcript keeps it **green**. | ✅ serial |
| **D4** | **Erase/temporal E2E** — the #205 acceptance scenario: Postgres→Kafka. `as_of` today returns **only** Kafka; `as_of` February returns Postgres. | ✅ serial |
| **D5** | **Full-sample LoCoMo rerun**, both configs (Ollama-only **and** codex-BYO), each cited from its own **run manifest**. Overnight. | ✅ serial, alone |

**D5 discipline** (all three earned the hard way today):
- **Emit the config from the run manifest, not from a hand-written spec line.** A prose config line in a spec caused four contradictory claims about one number in a single session.
- **Guard against the abstain floor.** An empty store scores **~22 F1** because ~22.5% of questions are adversarial and abstaining is *correct*. **A number came out is not evidence the run happened.** (#198 added this guard — verify it fires.)
- **Publish with the config inline.** An unlabelled "45.4" is the error, not the number.

---

---

# TRACK 2 — SCORE: the road to 0.60

*Runs alongside the stability track. **S1 needs no GPU and belongs in Wave A.** The rest are gated on Wave D.*

## The arithmetic first — because it kills the obvious plan

Current **0.4540** (n=199). Target 0.60 needs **+29 question-points of 199**.

**Perfect retrieval — zero abstention on every answerable question — gets you 0.545.** Not 0.60. Here is the whole budget:

| Category | n | abstained | × answered-F1 | gain if recall were perfect |
|---|---|---|---|---|
| single-hop | 70 | 14.7 | 0.57 | +8.4 |
| open-domain | 13 | 7.0 | 0.73 | +5.1 |
| multi-hop | 32 | 6.1 | 0.44 | +2.7 |
| temporal | 37 | 11.1 | **0.18** | +2.0 |

**Retrieval is not the constraint. `answered-F1` is** — and temporal (0.18) is an outlier by 2.5×.

## S1 — THE FORMAT ABLATION *(do this FIRST. Half a day. No GPU. Purely diagnostic.)*

`docs/eval/locomo-methodology.md` states our scoring is **harsher than upstream**: *"our answerer emits full sentences, not terse spans, which token-F1 penalizes independent of retrieval correctness."*

**Price that.** Gold: `"May 14, 2023"` (4 tokens). Our answerer: `"Caroline attended the LGBTQ support group on May 14, 2023"` (11 tokens).

> **Precision 4/11 = 0.36 · Recall 4/4 = 1.00 · token-F1 = 0.53.**
> **A perfectly correct answer scores 0.53.**

Single-hop's answered-F1 of **0.57** may already be **at the verbosity ceiling** — retrieval working fine, the metric eating the score. If so, every retrieval feature we ship is taxed ~40% on the way to the scoreboard.

**Estimated ceiling if format alone were fixed, retrieval held CONSTANT: ≈0.58.**

### ⚠️ The integrity line — read this before touching anything

`scripts/eval/locomo/answer.mts` is **FROZEN**. The score plan forbids changing the answerer, calling it gaming. **That rule is correct and S1 does not break it.**

The distinction:
- **Gaming** = tuning the answerer until the number goes up. **Forbidden.**
- **Measurement validity** = our answerer and upstream's emit *different shapes*, so `45.4` and their `41.4` **are not measuring the same thing** — and the difference systematically penalizes us.

**S1 is a measurement, not a change:**
1. Take the **existing** `hypotheses.jsonl` from the Config-B run (`.claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/2026-07-13T14-59-21-798Z/`).
2. Run it through a terse post-processor **offline**.
3. **Rescore.** Report both numbers side by side.
4. **DO NOT modify `answer.mts`. DO NOT re-run the daemon. DO NOT touch a model.**

**Deliverable:** how many points are **format** vs **retrieval**. Then — and only then — go read **what format the LoCoMo paper's own baselines emitted.** If they scored terse spans and we score sentences, our 45.4 *understates* us, and the roadmap changes from "grind four retrieval features" to "one measurement, then two features."

**This is the highest-leverage half-day on the board. It needs no GPU, so it runs in Wave A.**

## S2 — Temporal: measure #189 before building anything

Temporal answered-F1 is **0.18** — we answer 70% of temporal questions and get them **wrong**. Date-grounding shipped today (#189/#191) and **nobody has measured its effect.**

**Do not build a temporal feature until the rerun tells you where you now stand.** Estimated headroom if answered-F1 reaches 0.55: **+0.06 overall** — the single biggest quality lever.
**Gated on Wave D** (needs a real model).

## S3 — Multi-hop: graph expansion *(built, wired, never invoked)*

`entity_relations` (migration 027) is **populated**, and **recall does no expansion over it.** Named as the v1 retrieval surface in FEAT-481's own intake; never built.

Seed hits → neighbours via `entity_relations` → merge into candidates. **Est. +0.02.** Cheapest structural win on the board.
**⚠️ Evaluate jointly with single-hop** — expansion adds candidates, which can *dilute* precision and hurt S4. Never measure it in isolation.
**Code work: mockable, fits Wave A/B. Scoring: Wave D.**

## S4 — Open-domain recall *(do NOT fund yet)*

54% abstention on the category with our **best** answered-F1 (0.73) — when we find it, we nail it. But **n=13, of which only 6 were answered.** The 0.73 rests on six questions.
**Confirm on a full sample before spending an hour on it.** This is exactly the trap the score plan already flags.

## The honest ceiling

Stack **everything** — temporal → 0.55, single-hop recall + precision, graph expansion, open-domain recall, **minus** the adversarial bleed from answering more (abstaining less on cat-5 costs real points):

> **≈ 0.598.** Every lever pulled, no slack, on a metric taxing us ~40% for verbosity.

**Which is exactly why S1 goes first.** If the verbosity tax is real, 0.60 stops being a stretch target and becomes the **floor**.

**Cat-5 warning, stated once and loudly:** adversarial is **23.6% of all questions and scores 0.83 BY ABSTAINING.** Any global "abstain less" knob trades those points straight back and is plausibly net-negative. Every recall fix must discriminate *"no memory retrieved"* (correct abstain) from *"memory retrieved, answerer unconvinced"* (wrong abstain).

---

## Dispatch order

```
Wave A:  A1 ∥ A2 ∥ A3 ∥ A4 ∥ S1 ∥ S3(code)     5-6 worktrees, mocked, NO GPU
              ↓ merge
Wave B:  B1 → B2                                serialized; B1 needs the prod row-count gate
              ↓ merge
Wave C:  build + full suite, mocked, no model
              ↓ green
Wave D:  D1 → D2 → D3 → D4 → D5 → S2 → S3(score)   serialized, real Ollama, alone
```

**S1 (the format ablation) belongs in Wave A** — it rescores an existing `hypotheses.jsonl` offline. **No daemon, no model, no GPU.** It is a pure measurement and it can run overnight alongside the stability work with zero contention.

**S1 is also the highest-leverage item on either track.** If the verbosity tax is real (~13 points), it reframes the entire score roadmap before anyone writes a retrieval feature. **Half a day to find out.**

| Track | Slice | Wave | GPU? |
|---|---|---|---|
| Stability | A1 PID-identity · A2 telemetry · A3 redact · A4 validity | A | ❌ mocked |
| **Score** | **S1 format ablation** | **A** | ❌ **offline rescore** |
| Score | S3 graph expansion (code) | A/B | ❌ mocked |
| Stability | B1 drop tables · B2 regression test | B | ❌ |
| Score | S2 temporal measurement · S3 (scoring) | D | ✅ serial |
| Score | S4 open-domain | **deferred** | — (n=6; confirm on full sample first) |

**ETA:** Wave A ~2 days (A2 is the long pole; S1 is half a day). Wave B ~half a day. Wave C ~2 hours. Wave D ~1 day + one overnight for D5.

**Start with A1** — it is the only item that can actively destroy something *while the other waves run*: a sibling agent's process, Ollama, or the production daemon.

**Run S1 first among the score items** — it is the one that can tell you the other three are mis-prioritized.
