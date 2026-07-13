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

## Dispatch order

```
Wave A:  A1 ∥ A2 ∥ A3 ∥ A4        (4 worktrees, mock providers, no GPU)
              ↓ merge
Wave B:  B1 → B2                   (serialized; B1 needs the prod row-count gate)
              ↓ merge
Wave C:  build + full suite, mocked, no model
              ↓ green
Wave D:  D1 → D2 → D3 → D4 → D5    (serialized, real Ollama, nothing else running)
```

**ETA:** Wave A ~2 days of agent time (A2 is the long pole). Wave B ~half a day. Wave C ~2 hours. Wave D ~1 day + one overnight for D5.

**Start with A1.** It is the only item on this list that can actively destroy something *while the other three waves are running* — including a sibling agent's process, Ollama, or the production daemon.
