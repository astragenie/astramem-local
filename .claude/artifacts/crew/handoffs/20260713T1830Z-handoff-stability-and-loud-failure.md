# Handoff — STABILITY & LOUD FAILURE track (2026-07-13)

**For:** a session that owns *structural correctness, error handling, and stability*.
**Not for:** feature/LoCoMo work — that stays with the main session.
**Repo:** `astragenie/astramem-local` · `main` @ v0.16.0 (SCHEMA_VERSION 32) · prod daemon healthy on 0.16.0.

---

## The one idea

This repo's dominant failure mode is not crashes. It is **success and silent failure being the same observable state.**

`ADR-015: The Loud Failure Invariant` (merged today, PR #199) states it:

> A path MUST be able to distinguish a **REAL zero** from a **BROKEN zero** — and that distinction MUST be readable without a human present.

Today produced **three independent violations in one day.** That rate is the finding. Your job is to make the invariant enforceable rather than aspirational.

### The variant the ADR under-weights

All three of today's failures were **not** "no telemetry." They were **a green canary measuring the wrong quantity**:

| Failure | What the canary said | What was true |
|---|---|---|
| Entity extraction (#200) | `✓ Entity relations: 658 rows, fresh` | **~87% of memories got ZERO entities, for weeks** |
| Feedback loop (#190) | `✓ Usefulness feedback loop: active (0 used, 854 corrected)` | Positive signal has **NEVER fired**; the 854 "corrections" were consolidation's own auto-merges |
| Migration 030 (#185) | Green boot | One of two same-numbered migrations **silently skipped** |

**A green light that lies is worse than no light — you stop looking.**

Proposed rule (posted on #199, not yet in the ADR):
> A canary MUST measure the **rate of the failure**, not the **existence of a success**. "Some rows exist" is not evidence the pipeline works; it is evidence it works *sometimes*, which is indistinguishable from ~87% broken.

---

## Work in flight (pick this up)

**`audit-silent-errors` agent** — running now. Auditing:
- **39** empty catch blocks, **42** comment-only catches, **182** `fail-open`/`best-effort`/`silently`/`non-fatal` sites.
- **AC-2: `src/cli/index.ts` has NO global exception handler.** Only `src/cli/serve.ts:85-86` does (`uncaughtException`/`unhandledRejection` → `crashExit`). So `doctor`, `reinstall`, `queue`, `init`, `backup` have no safety net — an unhandled rejection there can die quietly or exit 0.
- Deliverable: `docs/specs/20260713-silent-error-audit.md` + a PR.

**Critical constraint I gave it, preserve it:** do NOT mass-rewrite all 182 fail-open sites. Many are correct and deliberate (`try { lock?.release(); } catch {}` in a crash path is *right*). Indiscriminate churn produces an unreviewable diff and **buries the real findings**. Only fix the class where **a real failure is swallowed and the caller proceeds as if it succeeded**, producing wrong data, a wrong metric, or a green status.

---

## Open structural issues, ranked

### 1. #188 — `schema_version` records only a NUMBER, no content hash
**Root cause of BOTH the migration collision AND the re-collision that bricked production today.**

`migrate()` keys a migration's identity on the number alone (`src/storage/migrate.ts:66`, `applied.has(version)`). So:
- Two files numbered `030` → one is **silently skipped**. Green boot, broken runtime.
- Renumbering an already-applied migration → the old number is skipped AND the new one re-runs → `CREATE TABLE ... already exists` → **hard boot failure**, with the misleading advice *"Restore from a backup rather than continuing."* (Nothing was corrupt. The real fix was two lines of SQL.)

**Fix:** add `content_hash` (+ ideally `filename`) to `schema_version`, verify at boot, fail with a precise diagnosis. #198 added numbering-invariant tests (contiguity, `SCHEMA_VERSION == max`) as a stopgap, but they cannot catch a renumber on an *already-deployed* DB — only a content hash can.

Verified recovery for a bricked DB (I ran this on prod):
```sql
DELETE FROM schema_version WHERE version = 30;
DROP TABLE IF EXISTS consolidation_judge_runs;
```

### 2. #200 — the entity-link canary measured the wrong thing
Linkage itself is **FIXED** (~87% → ~1-5% at 13:00 UTC today, via the `num_ctx` + temperature-clobber fixes). **No backfill** — operator confirmed pre-today memories aren't worth it.
**What remains:** a doctor canary on the **unlinked-memory RATE for recent memories**, and an `entity_link_drops` counter (mirroring `relation_guard_drops`, migration 029) so "model emitted nothing" is distinguishable from "we dropped it."

### 3. #190 — nothing ever calls `submit_feedback`
`recordRecallUsed` has exactly **2 callers**, both requiring an externally-supplied atom id. Neither `search_memory` nor `recall_memory` calls it. The plugin client (`astramem-plugin`) hits only `/ingest/transcript`, `/recall`, `/health`, `/remember` — **there is no feedback route on the client side at all.**

The daemon **architecturally cannot** know whether a memory was used; only the consumer can. **This is a cross-repo (plugin-side) design task.** Canary + source-tagging shipped in #196; the caller did not.

**Note — I was WRONG about the impact and the record should show it.** I claimed ε was "a one-way punishment term silently biasing every ranking." It is not: superseded/invalidated atoms are **removed from the candidate pool** (`search.ts:276` filters `valid_to IS NULL`), and with `used=0` everywhere `usefulness` is a uniform 0.5, so ε adds an identical constant to every score — **provably rank-invariant** (byte-identical ADR-005 floors at ε=0.1 and ε=0). **ε is inert, not harmful. Keep it at 0.1.**

### 4. #187 — FIXED today (#194), but know the shape
A linked worktree had its own branch and `dist/` but **not its own datadir**, so any agent running `serve`/`doctor`/`migrate()` from a worktree hit the **live production database**. That is how an uncommitted migration reached prod and took the daemon down. Now guarded at `resolveRuntimeConfig()`. Escapes are explicit (`ASTRA_MEMORY_DATADIR`, `:memory:`, `ASTRA_MEMORY_ISOLATED=1`, `--data-dir`, `ASTRA_ALLOW_PROD_DATADIR=1`).
**Sibling hazard, still open:** the **OS keystore is not datadir-scoped either** (FEAT-466). Same class. Worth closing the same way.

### 5. Dashboard: 5s auto-refresh on an 8s cold render
`/dashboard` cold-loads in **7.9s**, warm in **0.03s**, and the page carries `<meta http-equiv="refresh" content="5">`. The browser reloads mid-request and it looks hung. Users report it as "down" (it isn't). Either raise the refresh interval above the cold-render time, or make the cold query fast. **Note `better-sqlite3` is synchronous — a slow dashboard query blocks the whole event loop**, so this degrades the entire daemon, not just the page.

### 6. Poison jobs: 31 → 55 today
All new failures are `The operation was aborted due to timeout` — **Ollama saturation** from running four LLM-dependent agents in parallel against a single shared GPU. Not a code bug; an operational one. Worth a guard: distill should back off rather than burn its retry budget when the provider is visibly saturated.

---

## Hard rules (violating these has already caused incidents today)

- **NEVER** run `serve`/`doctor`/`reinstall`/`init` or anything calling `migrate()` against the **default datadir — it is PRODUCTION.** (Now guarded from worktrees, but the primary checkout is still live.)
- **NEVER** kill processes by image name (`taskkill /IM node.exe`). This box runs the prod daemon, Ollama, eval shards, and sibling agents.
- **NEVER** `git stash` — the stash stack is repo-global across worktrees.
- **NEVER** `git add -A` when sibling agents share the checkout. Today a PR swept up another agent's docs and silently reverted a correction.
- **NEVER** modify `scripts/eval/locomo/answer.mts`'s prompt/model/k — it is a deliberately fixed cheap answerer; changing it invalidates every benchmark number. (Adding a *guard* that refuses to score an empty store is fine — that is honesty, not tuning.)
- **Do NOT run LLM-dependent work in parallel against Ollama.** It is a single shared GPU. Four concurrent agents took embed latency from 37ms to 48s, poisoned 24 production distill jobs, and produced one garbage eval run.

---

## Meta-lesson worth carrying

Twice today I asserted something from **inference where a measurement was available**, and was wrong both times:

1. *"Prod is fine — its schema 30 is evidence-guard."* It was judge-runs. **Prod was bricked.** I should have read the DB.
2. *"ε is a punishment term biasing every ranking."* It is rank-invariant. I reasoned from the formula and never checked whether the penalized rows reach the ranker.

Both would have taken one query to check. **In this codebase, if a measurement is available, take it — the guard you assume is missing is usually there, and the failure you assume is loud is usually silent.**
