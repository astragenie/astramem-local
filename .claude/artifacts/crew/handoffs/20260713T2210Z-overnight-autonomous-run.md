# Overnight autonomous run — 2026-07-13 22:10Z

**Operator asleep. This is what I committed to, what I refused to do, and where to look first if something is wrong.**

---

## READ THIS FIRST IF SOMETHING BROKE

**Production baseline at handoff (22:09Z):**
```
status: ok    embed.ok: true    worker.alive: true    schema_version: 39    uptime: 85min
Ollama VRAM: qwen3:8b 6.2GB + mxbai-embed-large 0.6GB = 6.8GB / 8GB (85%)
```

If prod is degraded and I did not leave a report saying so, **compare against this.** The most likely cause is GPU contention from the LoCoMo run (D5), not a code change — every code change went through CI on a clean runner.

**To check:** `curl -s http://127.0.0.1:7777/health`

---

## Merged today (10 PRs, all reviewed, all CI-green)

| PR | What it fixed |
|---|---|
| **#224** | `stopLockHolder` verified a PID was *alive*, never that it was *our daemon* — then force-killed it. Fires from a ≤3-min watchdog. Now verifies PID + OS start-time. Six call sites, incl. a fifth (`restore.ts`) the plan didn't know about. |
| **#229 + #233** | `SCHEMA_VERSION` was a hardcoded literal in nine places → **any two migration PRs conflicted by construction.** Now derived from `migrations/`. Zero literals repo-wide. |
| **#230** | Quarantine held pre-existing plaintext; existing dirs kept loose perms. Plus: a walk failure and a parse failure shared one catch block, so valid-but-deep JSON got raw-text-mangled while reporting success. |
| **#232** | **Five unbounded full-table scans were silently promoted onto a 15-minute unattended loop in production.** `tier` is now a REQUIRED field — an untiered check will not compile. |
| **#234** | Dropped three zero-writer tables; repointed the dashboard's always-empty provider panel at live `config.embedding`. |
| **#236** | Identity check proven against a *real* spawned process, not an injected stub. |
| **#237** | `service status` could say **"Service: not installed. Run `service install`"** for a service that WAS installed — because a query timed out. Plus a 5s timeout on a 6.1s cold PowerShell start (failed closed on every call). |
| **#238** | **ADR-016 — The Junction Invariant.** |
| **#241** | MCP tool count was hand-maintained in 4 places. Now derived. |

---

## In flight when I handed off

| | Status |
|---|---|
| **#231** | `checks.ts` split (2,167 lines → 35 files). Rebasing over #232 — every check needs a `tier:` copied from #232's *reviewed* classification. **A mis-tagged `cheap` check puts an unbounded scan back on the 15-min loop.** |
| **#239** | **Write-path redaction — the last real security gap.** Every capture with an unrecognised field still lands on disk **in plaintext**. #225's claim "redact before the bytes hit disk" is false today for anything outside four known fields. |

---

## A LoCoMo FULL-SAMPLE RUN WAS ALREADY LIVE — I did not start a second one

Operator flagged it mid-session. **PID 167340**, in worktree `astramemory-local-wt-locomo-postfix`:

```
run.mts --dataset locomo10.json          <- FULL dataset, all 10 conversations
        --extract-profile conversational
        --extraction-provider codex-subscription --extraction-model gpt-5.4-mini
        --compaction-provider ollama --compaction-model qwen3:8b
        --distill-timeout-ms 5400000     <- 90 min
        --run-dir .eval-data/locomo/runs/20260713-codex-qwen
```

**That IS D5.** Results will be in that run-dir with its own manifest — **cite the manifest, not a prose config line.** (Four contradictory claims were made about one number today because someone read a spec line instead of a manifest.)

## CORRECTION — I DID cause Ollama load, and I contributed to the production outage

**I first wrote here: "I ran ZERO Ollama work all night." That was FALSE.** Read this before anything else.

The command I mandated as the merge gate for **every agent** tonight —

```
bun run test -- --testTimeout=60000     # "exactly as CI runs it, no env vars"
```

— **fires live `qwen3:8b` calls on this box.** Five test files self-gate only on *"is Ollama reachable"* (an `/api/tags` ping) and **ignore `ASTRA_MEMORY_MOCK_PROVIDERS` entirely**:

- `tests/consolidate/contradiction-e2e.test.ts`
- `tests/providers/llm-contract-conformance.test.ts`
- `tests/providers/ollama-embed.test.ts`
- `tests/providers/ollama-llm.test.ts`
- `tests/providers/_llm-provider-adapters.ts`

**CI is safe only because CI has no Ollama. This machine does.**

So while I believed I was running zero GPU work, **I ran that command myself for Wave C at 22:16Z — during prod's crash loop — and had five agents running it in parallel.** Every one fired live LLM calls into a GPU already saturated by the eval.

**Production's Ollama latencies went from milliseconds to 53s, then 82s. Then it died.** I blamed the LoCoMo eval. **The eval was half of it. I was the other half.**

`ASTRA_MEMORY_MOCK_PROVIDERS=1` — the flag `CLAUDE.md` tells everyone to set, the flag every wave plan hands out as the safety mechanism — **does not work.** Filed as **issue #251**.

This is the day's own thesis landing on me: **a claimed guarantee that isn't wired up is worse than no guarantee, because you stop checking.** I spent the whole day catching that pattern in other people's code.

**What I changed:** stopped every agent from running the full suite; targeted tests only, and **let CI provide the broad signal** (CI has no Ollama — it is the environment that command actually assumed).

## WHAT I REFUSED TO DO UNATTENDED

**D2 — the kill-path E2E.** It SIGKILLs a daemon, recycles a PID, and fires the watchdog **on the box running production, Ollama, and a live eval.** It is the one test that can actually destroy something, and the one I could not recover from with the operator asleep. **It waits.**

**D1 and D3** — both need real Ollama. The eval owns the GPU. Deferred to the morning queue alongside D2.

**Standing rules held all night:** never touch the production datadir; never kill by image name; **never kill a process I did not spawn** (the live eval was explicitly left alone); no force-push to main; no tags; no prod deploy; every PR gets a reviewer before merge.

---

## The finding of the day (not any individual bug)

**Five separate times, a green test suite meant nothing:**

1. `git checkout --ours` is **inverted during a rebase** (`--ours` = upstream, not your work) → six files silently reverted. **Suite stayed green because the literal happened to equal the derived value.**
2. A tier fix was verified locally and **never committed** before the force-push. Clean working tree, broken pushed ref.
3. `"41/41 checks, identical names and order"` — a names-and-order diff **cannot see a flipped threshold**.
4. The spool redaction fix was wrong **three times**, each version passing a green suite.
5. The stack-overflow bug is **invisible to vitest by construction** — the test runner's stack is *deeper* than the daemon's.

Every one was caught by someone **re-deriving the claim from the source** instead of trusting the report upstream of them — **including, three times, when the report upstream was me.**

Three times an agent stopped and told me my instruction was wrong, with a reproduction. Each time it was right:
- a raw-text redaction scan would have **corrupted JSON on every capture**;
- a bare deep-walk would have **destroyed session identity on every capture** (schema still passes — placeholder is a non-empty string);
- a schema-inversion would have **redacted nothing new**.

---

## Open items NOT in the plan — flagging so they don't get lost

- **Issue #235** — `typecheck:tests` has **never run in CI**. Every type-level guarantee in `tests/` is decoration. Blocked behind ~10 pre-existing errors.
- **ADR-016 §6 admits, in writing:** of its six binding rules, **exactly one has live automatic enforcement.** The Junction pattern *will* recur.
- **runner-plugin#508** — the loop has no allocation protocol for globally-scarce values (migration numbers, ports, any monotonic counter). N parallel agents will always race for the same integer.
- **The LoCoMo score track is untouched.** Everything today was stability. The road to 0.60 — temporal extraction, the answer-format fix — has not been started, and it is the track with the actual product upside.
