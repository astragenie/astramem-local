# Handoff — OVERNIGHT WAVE A (stability + atom validity)

**For:** the session implementing overnight, unattended.
**Plan:** `docs/specs/20260713-stability-wave-plan.md` (PR #203). **Read it first — this handoff is the delta, not a replacement.**
**Repo:** `astragenie/astramem-local` · `main` @ v0.16.0 (SCHEMA_VERSION 32).

---

## ⚠️ READ THIS FIRST — the box is degraded RIGHT NOW

Live `/health` at handoff time:

```json
"status": "degraded",
"embed":  { "ok": false, "last_error": "ollama: timeout" },
"queue":  { "pending": 7, "running": 2, "poison": 56 }
```

**The production daemon cannot reach Ollama.** Its VRAM is held by a test run (`qwen3:8b`, 6.1 GB of 8 GB). Every distill job that times out burns 3 retries and then **poisons permanently — those memories are lost.** Poison count today: **31 → 55 → 56 and climbing.**

**Before you start:**
1. **Confirm nothing else is using Ollama.** `curl -s localhost:11434/api/ps` must return `{"models":[]}`.
2. **Confirm the daemon recovered:** `curl -s localhost:7777/health` → `"status":"ok"`, `"embed":{"ok":true}`.
3. **If it is still degraded, do NOT start Wave A.** You will be building on a box that is actively losing production data. Fix the contention first.

**Then: Wave A does not touch Ollama at all.** See the hard rules below. If you find yourself waiting on a model during Wave A, you have made a mistake.

---

## The one rule that matters overnight

> **`ASTRA_MEMORY_MOCK_PROVIDERS=1` on every worktree. No exceptions in Waves A–C.**

Unattended + real GPU + shared box = the incident above, but for eight hours with nobody watching. **The entire suite passes with mocked providers** — `src/cli/demo.ts` and the test suite already use this path, and `serve`/`mcp-stdio` both honor it. Nothing in Wave A needs a real model.

**Per-worktree env, verbatim, every one:**
```bash
export ASTRA_MEMORY_ISOLATED=1
export ASTRA_MEMORY_MOCK_PROVIDERS=1
export ASTRA_MEMORY_DATADIR="$PWD/.dev-datadir"
export ASTRA_MEMORY_TOKEN=devtok        # OS keystore is NOT datadir-scoped (FEAT-466)
```
**The default datadir IS PRODUCTION.** A worktree without its own datadir is how an uncommitted migration bricked the daemon today (#187/#194). `ASTRA_ALLOW_PROD_DATADIR=1` is **forbidden** in every wave.

---

## Wave A — four worktrees, parallel, file-disjoint

| Slice | Branch | Owns (exclusive) | Port |
|---|---|---|---|
| **A1** PID-identity check | `fix/pid-identity-check` | `src/service/instance-lock.ts` | 7801 |
| **A2** zero-yield telemetry + doctor | `feat/zero-yield-telemetry` | `migrations/032-*.sql`, `src/doctor/**`, `src/distill/stages/08-embed-index.ts` | 7802 |
| **A3** redact at spool-write | `fix/redact-at-spool-write` | `src/capture/proxy.ts`, `src/ingest/spool*.ts`, `src/redact/**` | 7803 |
| **A4** atom validity (#205) | `feat/atom-validity-interval` | `src/distill/prompts/extract.ts`, `src/storage/memories.ts` | 7804 |

**Disjointness is load-bearing.** A2 and A4 both live under `src/distill/` but in **different files**. **A2 owns `migrations/` — no other slice may add a migration.** A4 owns `storage/memories.ts` — A2's telemetry goes in its own module.

**Never `git add -A`.** Today that swept up another agent's docs and silently reverted a correction. Stage explicit paths.

---

## A1 — start here. It is smaller than the plan says.

**New information found at handoff time.** The lock file already contains the identity data:

```json
{"pid":161504,"startedAt":"2026-07-13T18:52:52.549Z","port":7777,"version":"0.16.0"}
```

**`startedAt` is already written.** `stopLockHolder` simply never compares it. So this is **a comparison, not a new field** — smaller than the plan assumes. Verify before building.

**Four call sites — fix at the `stopLockHolder` implementation, which covers all four by construction. Do NOT patch callers.**
1. `watchdog-probe.ts` — the ≤3-minute timer.
2. `reinstall.ts` ×3 — plain / `--rollback` / `--dev`.
3. **`src/cli/service.ts` — `service stop`.** Found by review; missed by the original investigation. **The command a human actually types.**

Cross-platform identity: `/proc/<pid>/stat` field 22 (Linux); PowerShell `Get-CimInstance` on Windows — **not `wmic`** (removed on current builds). **Fail closed if the identity check itself errors**, not only on a confirmed mismatch.

**Acceptance — BOTH directions or it's not done:**
- Forged lock, live PID, **mismatched** start-time → **refuses to signal.**
- Genuinely wedged daemon, **matching** start-time → **still killed.**

*Without the second test you ship a watchdog that never kills anything, the hang-watchdog is silently neutered, and the suite calls it green. That is precisely the ADR-015 failure mode — do not commit it inside the fix for ADR-015.*

## A2 — zero-yield telemetry (the long pole)

A well-formed `{"atoms":[]}` **completes successfully**. A broken model and a quiet week are the same observable state.

- Copy the `relation_guard_drops` (migration 029) + `checkEntityRelations` pattern. **Do not reinvent it.**
- **ADR-015 rule 6 — state the denominator.** Not "N atoms produced." **"K of N transcripts produced zero atoms."** *If you can't state the denominator, you haven't written a canary.*
- Alarm on a **rolling rate**, gated by `MEANINGFUL_USAGE_THRESHOLD`. A single zero is normal.
- `checkMemoryHealth` gains a real **`ok:false`** branch (currently hardcoded `ok:true`).
- `serve.ts` schedules `runChecks` — **split the cadence.** `llmChatProbe` makes a **real LLM call**; a tight interval is a self-DoS and, on a metered endpoint, is the FEAT-482 incident class (~245 calls, worker wedged 10+ min). Cheap DB checks frequent; LLM probes on the existing 24h tick.
- **Migration + write site + doctor read in ONE PR.** No fifth orphan table.

## A3 — redact at spool-write

Proxy transcripts spool **plaintext**; parse failures quarantine **before** redaction. No TTL, no canary. **Selection effect: content that breaks a parser is disproportionately content containing secrets.**

The "it costs proxy latency" objection is **false** — capture already runs in `setImmediate` *after* the client response completes (ADR-013 Decision 3). **Redact at spool-write, for everything.** Plus `.quarantine/` TTL, keystore-grade perms, doctor canary on depth/age.

## A4 — atom validity (#205)

`AtomSchema` has no atom-level `valid_at`/`invalid_at`; `InsertInput` has no `valid_to`. **Storage and `as_of` retrieval are already correct** — nothing populates them.

**Decide `NULL` semantics before writing code.** A backfill is impossible, so the mixed store is **permanent**: is `valid_to IS NULL` *"valid forever"* (current, defensible) or *"unknown"*? Write the answer into the migration **and** `CLAUDE.md`.

**Expect zero LoCoMo movement. That is success, not failure** — the harness never sets `as_of`. This is a product fix, not a score fix. **Do not tune anything to chase a number here.**

---

---

## S1 — FORMAT ABLATION. Add this to Wave A. It needs no GPU, and it may be the most important half-day on either track.

**Why it's here:** it rescores an **existing** `hypotheses.jsonl` offline. No daemon, no model, no GPU, zero contention with anything. It runs overnight alongside the stability work for free.

**Why it matters more than it looks.** `docs/eval/locomo-methodology.md` admits our scoring is **harsher than upstream** — our answerer emits full sentences, gold answers are terse spans, and token-F1 punishes that **independent of retrieval correctness**. Price it:

> Gold: `"May 14, 2023"` (4 tokens). Ours: `"Caroline attended the LGBTQ support group on May 14, 2023"` (11 tokens).
> **P = 4/11 = 0.36 · R = 1.00 · token-F1 = 0.53.**
> **A perfectly correct answer scores 0.53.**

Single-hop's answered-F1 of **0.57** may already be sitting **at the verbosity ceiling** — retrieval working fine, the metric eating the result. If that's true, **every retrieval feature we ship is taxed ~40%** on the way to the scoreboard, and the score roadmap is mis-prioritized.

### ⚠️ THE INTEGRITY LINE — do not cross it

`scripts/eval/locomo/answer.mts` is **FROZEN.** Changing the answerer to raise the number is **gaming, and it is forbidden.** S1 does **not** do that.

- **Gaming** = tune the answerer until the score goes up. ❌
- **Measurement validity** = our answerer and upstream's emit *different shapes*, so `45.4` and their `41.4` **are not the same measurement.** ✅ That is a fact worth establishing.

**The procedure — a measurement, not a change:**
1. Take the **existing** Config-B hypotheses: `.claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/2026-07-13T14-59-21-798Z/hypotheses.jsonl`
2. Post-process to terse spans **offline**.
3. **Rescore.** Report both numbers side by side.
4. **DO NOT modify `answer.mts`. DO NOT re-run the daemon. DO NOT load a model.**

**Deliverable:** how many points are **format** vs **retrieval** — then go check what format the LoCoMo paper's own baselines emitted. If they scored terse spans and we score sentences, **our 45.4 understates us**, and the roadmap changes from "grind out four retrieval features" to "one measurement, then two."

**Estimated: format alone ≈ 0.58, with retrieval held completely constant.**

### Context for whoever picks up the score track later

**Retrieval is NOT the constraint.** Perfect recall — zero abstention on every answerable question — caps at **0.545**. `answered-F1` is the constraint, and **temporal (0.18) is an outlier by 2.5×**: we answer 70% of temporal questions and get them *wrong*.

Stacking every lever (temporal → 0.55, single-hop, graph expansion, open-domain, minus the adversarial bleed) lands at **≈0.598** — no slack. **Which is why S1 goes first.** If the verbosity tax is real, 0.60 stops being a stretch target and becomes the floor.

**Cat-5 trap, do not forget it:** adversarial is **23.6% of questions and scores 0.83 BY ABSTAINING.** Any global "abstain less" knob trades those points straight back and may be net-negative.

**Do NOT fund open-domain yet** — its 0.73 answered-F1 rests on **six answered questions** (n=13). Confirm on a full sample first.

---

## Wave B (serial, after A merges)

**B1 — drop `messages`, `artifacts`, `provider_state`.** Collides with A2 on `migrations/`, and is **irreversible** (`reinstall --rollback` repoints code, not schema).

**Safety gate, non-negotiable:** `SELECT COUNT(*)` on all three **against the real production DB, read-only** (do NOT run `migrate()`). Git history proves *this repo* never wrote them — **not** that nothing ever did. **Non-zero count halts the drop.** Remove the dashboard's dead `provider_state` read (`queryProviders`) in the same PR or you ship a query against a dropped table.

## Wave C — full suite green, still no model

`bun run build` + `vitest run` with `ASTRA_MEMORY_MOCK_PROVIDERS=1`. **Demonstrate A2's core claim:** doctor goes **red** on a simulated broken extractor and **green** on a genuinely contentless one. *If you cannot show that distinction, A2 did not land.*

## Wave D — E2E. The ONLY phase that touches Ollama. Serial. Alone.

Do **not** start Wave D overnight unattended unless the box is confirmed idle.

D1 real-daemon smoke · **D2 kill-path** (SIGKILL, recycle PID, assert the innocent process survives — A1's reason to exist; a unit test cannot prove it) · **D3 loud-failure** (broken model → doctor red unattended) · **D4 temporal** (#205 Postgres→Kafka scenario) · **D5 full-sample LoCoMo, both configs, from run manifests**.

---

## Eval result — settled today, and it changes the plan's assumptions

`docs/eval/20260713-locomo-10pct-two-config.md` (**⚠️ currently uncommitted, living only in worktree `agent-a0112287d8dd8d401` — commit it before it is lost, as other docs were today**):

| | Config A (codex extract) | **Config B (local qwen3:8b)** |
|---|---|---|
| Overall F1 | 0.4278 | **0.4540** |
| Atoms/session | 10.53 | 10.05 |
| Wall clock | **16.6 min** | 47.3 min |

**Three conclusions that matter for this plan:**
1. **0.4540 is the LOCAL, zero-account number.** The zero-account story is the *stronger* one. Never publish it unlabelled — always `45.4 (Ollama qwen3:8b, n=199, token-F1)`.
2. **The extraction PROFILE was the fix, not the extractor.** Atoms/session ~10 in *both* configs vs 0.5 at baseline (~20×). Do not chase extractor swaps for score.
3. **Local wins on score, codex wins 3.6× on wall-clock, both cost $0.** The gap is **within noise at n=199** — do not claim "local beats cloud." The defensible claim is **"local is not worse."**

---

## Hard rules (each has already caused an incident today)

- **NEVER** run `serve`/`doctor`/`reinstall`/`init`/`migrate()` against the **default datadir — it is PRODUCTION**.
- **NEVER** kill by image name (`taskkill /IM node.exe`). This box runs the prod daemon, Ollama, eval shards, and sibling agents.
- **NEVER** `git stash` — the stash stack is repo-global across worktrees.
- **NEVER** `git add -A` in a shared checkout.
- **NEVER** run LLM-dependent work in parallel against Ollama. One model-dependent process at a time.
- **NEVER** touch `scripts/eval/locomo/answer.mts`'s prompt/model/k — it is a deliberately fixed cheap answerer; changing it invalidates every number. *(Adding a guard that refuses to score an empty store is fine — that's honesty, not tuning.)*

## The meta-rule for an unattended night

Today, **five separate confident claims about one config line were wrong** — including four *corrections*, each made with more authority than the thing it overrode. The pattern: **inference where a measurement was available.**

> **If a measurement is available, take it.** The guard you assume is missing is usually there. The failure you assume is loud is usually silent. **A failed search is not evidence of absence — it is evidence about your search.**

And the one that cost the most: **an absence claim deserves MORE scrutiny than a presence claim, not less** — because there is no artifact to check it against. I called two real run-manifests "fabricated" because I ran `find` with `-maxdepth 6` against a path 8 levels deep. **Do not skip dot-dirs. Do not cap depth.**
