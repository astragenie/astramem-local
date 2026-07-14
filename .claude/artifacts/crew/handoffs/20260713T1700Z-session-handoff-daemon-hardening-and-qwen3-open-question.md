---
type: session-handoff
created: 2026-07-13T17:00:00Z
session: daemon hardening (quota, diagnosability, schema) + qwen3:8b quality — UNRESOLVED
repo: C:\work\mega\astramemory-local
confidence: high on what shipped; LOW on whether qwen3:8b is the right default
---

# Session handoff — 2026-07-13

## READ THIS FIRST

**Work from `C:\work\mega\astramemory-local`.** This session ran with cwd
`C:\work\mega\memory` (the *cloud* repo) and every command needed a `cd`. Several real
mistakes trace directly to that — a `nohup`-launched benchmark silently reaped, branches cut
from a stale local `main` causing phantom conflicts. The operator called this out. Fix it by
starting in the right directory.

---

## THE OPEN QUESTION (the only one that matters to the operator)

**Is `qwen3:8b` good enough for distill? NOBODY KNOWS. Including me. I shipped it as the
default anyway.**

- The **only** qwen3:8b benchmark that exists (`results/ab-run-2026-07-08/`) is **INVALID** —
  it ran before the `think:false` fix (commit `1915521`), so qwen3 ran with thinking-on +
  `format:json`, which returns an **empty `message.content`**. That single bug explains its
  2.4× latency, its 31% type accuracy, AND its failed fixture, simultaneously. **It measured a
  bug, not the model.** The report is annotated in place — do not cite its qwen3 row.
- My own 6-sample bench measured **latency only**. Says nothing about quality.
- `src/cli/init.ts` now advertises the model with `'benchmark pending'` rather than a stat,
  because carrying qwen2.5's measured F1 (67%) onto an unbenchmarked model would be fabricating
  a number into the product UI.

**A bench WAS running at session end** (task `bw0kvxh8j`):
```
bun scripts/eval/extraction-bench/run-bench.mts \
  --models qwen3:8b --runs 1 --skip-judge \
  --out-dir scripts/eval/extraction-bench/results/qwen3-live-2026-07-13
```
43 gold fixtures, local Ollama only, zero cloud calls. **Check for results there first.** If
absent, re-run — it takes ~45 min.

**IMPORTANT — the bench cannot fully answer the question.** Its fixtures are real coding
transcripts. But the hollow atoms in the operator's live store are *not* extraction failures:

```
"Failure/budget semantics"                     <- a section HEADING
"AC-1: Skip reinstall if version is current."  <- a SPEC LINE
"A reinstall occurred during the deployment process."
```

vs. genuinely good ones from the same store:
```
"Extraction using qwen3:8b silently returned empty JSON and…"
"The qwen3:8b-class thinking-mode failure did not occur wi…"
```

The model is **faithfully extracting from crew ceremony artifacts and slice specs that got
ingested as if they were conversations.** That is an **INGEST-SCOPE** problem, not a model
problem. If the bench comes back clean, look there next — what is being fed to distill in the
first place.

---

## MERGED TODAY

| PR | |
|---|---|
| #174 | 12 branches: chunk-retry (3× quota amplification → ~1×), cross-provider conformance suite (found **2 more armed provider bugs**), doctor GPU/orphan checks, content-hash release guard, eval harness typechecked **for the first time ever**, qwen3:8b default |
| #176 | doctor persisted-env honesty fix |
| #180 | judge wall-clock cap, `pipeline.concurrency: 2`, ingest errors name the field, sync errors name the failing layer |
| #183 | **`bun.lock` was never in the published package** — `reinstall` was broken for *every* registry-installed user |
| #184 | drops the dollar cap on the judge (it can **never fire** — both providers report `usd: 0`), adds judge telemetry |
| #186 | **OPEN — MERGE THIS.** Migration-030 collision (#185). |
| #178 | closed, superseded by #174 |

Also: `CLAUDE.md`'s **"No sync bridge"** corrected (it was FALSE), devops issue #87 filed for
root-owned files poisoning the CI runners.

---

## URGENT — #186 MUST MERGE

**Two different migration `030`s existed at once.** `migrate()` starts at `user_version + 1`,
so a DB already at 30 **skips the second `030` entirely** — its table is never created while
the code that queries it ships anyway. Green boot, silent runtime failure.

- The operator's **prod DB is at user_version=30** with `evidence_guard_drops` (applied from an
  agent worktree against the PRODUCTION datadir — that is the root cause).
- `main` shipped `030-consolidation-judge-runs.sql` (#184) — same number.
- #186 keeps `030` for evidence-guard (it is what is *actually in the live DB*; renumbering
  would strand it) and moves judge telemetry to `031`. Adds a guard test: **no two migration
  files may share a number.**

**Until #186 merges + the daemon reinstalls: every CLI command (`queue`, `doctor`, `reinstall`)
is broken, and the daemon will NOT boot on its next restart.** It works only because it holds
an already-open handle. `/health` **hides this** — it reports `schema_version` from the
CONSTANT, not from the DB.

---

## THE PATTERN — this is the real deliverable

Every serious bug found was **a gate that ran, reported confidently, and could not see the
thing it guarded**. Not missing gates. **Misaimed** ones — which are worse, because a missing
gate looks missing while a misaimed one looks like evidence.

- release guard verified a `--version` string that **cannot change** on an uncommitted edit →
  shipped a stale binary 3× while reporting success
- `doctor` read `process.env` of the **doctor process**, not Ollama's → printed `(unset)` for
  settings that were demonstrably ON
- 2743 tests green while `json` was forced onto the **prose** compaction stage in all 3
  providers — a per-provider suite **structurally cannot see a divergence BETWEEN providers**
- `tsc` never saw `scripts/eval/**` (75 files) — every number the project's decisions rest on
  came from code the compiler never checked
- a **dollar cap** on providers that hardcode `usd: 0` — it can never fire
- an ingest error that named **no field** (`z.union` blind-flattens when a payload matches
  neither branch)
- `fetch failed` **discarding `err.cause`**, the one fact that names the failing layer
- `reinstall` demanding a lockfile that was **never published**
- `/health` reporting schema from a constant it never reads
- **twice, my own tests — passing against unfixed code**
- **once, this bench — reaped by the exact mechanism I had warned the operator about an hour
  earlier**

**The move:** when a check is green, ask *"what would have to be true for this to be green AND
the system broken?"* If you can answer in one sentence, the check is aimed left of the thing.

---

## STILL OPEN

- **#186** — merge, then `astramem-local reinstall`.
- **Daemon needs reinstall** after #186 to pick up today's work.
- **`llm.extraction.provider` is still `codex-subscription`** in the operator's live
  `config.yaml` — every distill runs through their personal ChatGPT quota via an unofficial
  endpoint. The amplification fix is live so a rate-limit no longer triples it, but they may
  want `ollama`.
- **FEAT-480 (BM25 revive)** — NOT merged. The dead-leg fix is correct (`escapeFtsQuery` quotes
  every token; FTS5 implicit-ANDs them; the keyword leg returns **zero hits, always**). But
  α=0.1 is **provably identical to α=0** on the current store, and the 5-token threshold has a
  proven hole (`"where's the daemon port"` → 4 tokens → 0 rows). Land the fix, **re-sweep α**.
- **A stash exists**: `stash@{0}: WIP on main: 0087d29 (FEAT-458 S5)`. Not mine. May be salvage.
- **CI runners are poisoned** — `container:` jobs run as root and leave root-owned files in
  `_work`, so `actions/checkout` dies with EACCES on runner-4 AND runner-5. Failures are
  attributed to the **job's name** (a red "TypeScript type-check" that never ran the compiler),
  so someone will eventually hunt a bug that does not exist. devops #87.

## HARD-WON OPERATIONAL FACTS

- **`bun test` hangs silently** on this repo (better-sqlite3). Always `bunx vitest run`.
- **Never launch a long eval with `nohup … &` from an agent shell** — the sandbox reaps it
  silently, no error, no trace. Use harness-managed background tasks. This destroyed a run today
  and a 40-minute one on 2026-07-08.
- **Force-killing Ollama orphans `llama-server.exe`, which KEEPS its VRAM.** Six orphans leaked
  6.8 GB of an 8 GB card; the model silently ran on CPU and it read as *"this model is slow."*
  The only tell is `/api/ps` → `size_vram` vs `size`. **Never kill by image name.**
- **Never `git stash`** — the stack is repo-global across worktrees.
- **Auto-merge fires the instant REQUIRED checks pass.** It raced a follow-up commit today
  (#176) and merged #184 while I was mid-investigation. A PR is live the moment required checks
  go green — do not treat it as a staging area.
- **Never apply a migration against the production datadir from a worktree.** That caused #185.
