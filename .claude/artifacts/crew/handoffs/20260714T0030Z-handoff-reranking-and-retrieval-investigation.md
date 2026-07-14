# Handoff — reranking / retrieval investigation (2026-07-13 late)

**Objective:** decide whether ranking work (ζ, cross-encoder rerank, multi-hop
decomposition) can move the LoCoMo score, and if so, do it.

**Owner:** incoming session.
**Read first:** `docs/research/20260713-locomo-full-suite-result.md` and
`.claude/artifacts/loop/backlog/pending/FEAT-487.md` (both merged, PR #259).

---

## The number you are optimising against

First **full-suite** LoCoMo run (n=1986 — every prior number in this repo came
from ONE conversation, n=199):

```
1 (multi-hop)   : 0.3145   (282)
2 (temporal)    : 0.1318   (321)
3 (open-domain) : 0.2318   (96)
4 (single-hop)  : 0.4332   (841)   <- 42% of the benchmark
5 (adversarial) : 0.8924   (446)

Category-averaged : 0.4007
Overall (F1)      : 0.4610   n=1986
```

**Optimise against the categories, not the headline.** The overall is flattered by
adversarial (446 questions where abstaining is correct, scored binary). A system
with **no memory at all** scores ~22 by abstaining on everything.

Run provenance: commit `429e99c`, codex extraction (`gpt-5.4-mini`), qwen3:8b
compaction, conversational profile, k=10, **answerer unmodified**. 2488 atoms,
99.6% entity linkage, 0 poison.

---

## IN FLIGHT — do not duplicate these

### 1. Retrieval diagnostic (THE GATE) — RUNNING

```bash
# daemon already up on the completed eval store:
#   port 7899, token: diag0000000000000000000000000000000000000000000000000000000000
#   datadir: astramemory-local-wt-locomo-postfix/.eval-data/locomo/runs/20260713-codex-qwen/datadir
#   (2488 atoms — verified)

bun scripts/eval/locomo/diagnose-retrieval.mts \
  --sample <run>/sample.json --daemon-url http://127.0.0.1:7899 \
  --token <tok> --category 4 --out <run>/diagnosis-singlehop.json
```

Buckets every single-hop miss into:

| bucket | meaning | consequence |
|---|---|---|
| `not-in-DB` | never extracted | **FEAT-487 is WORTHLESS — close it, go do extraction** |
| `rank-miss` | extracted, ranked below k=10 | **FEAT-487 is the answer — build it** |
| `rank-ok` | retrieved fine, answered wrong | answerer/ambiguity — **out of scope** |

**This is a gate, not a formality. It can kill 12-18h of work in 1-2h.** Single-hop
is 42% of the benchmark; guessing which bucket dominates risks spending the
biggest lever on the board on the wrong fix.

**If it has finished by the time you read this, the result is in
`<run>/diagnosis-singlehop.json`. Read it BEFORE writing any ranking code.**

Also run it for category 1 (multi-hop, 282q) — same command, `--category 1`.

⚠️ Read the diagnostic's own header first. It already fixed a pool-composition
bug: a deeper `--limit` silently raises `vecK`, which changes min-max
normalisation in `fuse.ts`, which changes rank. A "rank-ok at limit=500" does NOT
mean "findable at k=10".

### 2. qwen3.5:4b extraction bench — RUNNING (~40 min left)

```bash
bun scripts/eval/extraction-bench/run-bench.mts --models qwen3.5:4b \
  --compaction-model qwen3.5:4b --runs 3 \
  --out-dir scripts/eval/extraction-bench/results/qwen35-4b-2026-07-13
```

Run 1 of 3 complete: **43 fixtures, 128 atoms, mean 3.0 atoms/fixture, 8
zero-atom fixtures, ZERO crashes.** (Some zero-atom fixtures are *correct* — the
bench has deliberate "nothing" fixtures; the report's `over-extract (nothing fx)`
column tells them apart.)

`--runs 3` is mandatory: a single run has a **±14 F1 swing** on the same model
(FEAT-450). Do not read a one-run number.

---

## THE HEADLINE FINDING FOR YOU

**`qwen3:8b` — the SHIPPED DEFAULT extraction model — is measurably broken.**

- In the real LoCoMo eval: **4 jobs in 20 minutes**, 3 poisoned, timeouts.
- The extraction bench **already in this repo** records it at
  **20 failed fixtures, 154.5s/session, no F1 at all**
  (`scripts/eval/extraction-bench/results/qwen3-live-2026-07-13/report.md`).
- **The evidence existed and nobody ran it.** `built-wired-never-invoked`,
  pointed at our own evaluation tooling.

Root cause: **VRAM.** RTX 5060 Laptop, 8151 MiB. `qwen3:8b` = 5896 MB resident +
embedder 590 MB = ~6.5 GB before any KV cache. `num_ctx` is sized per call (cap
16384), so a big prompt pushes past VRAM, Ollama **spills layers to CPU**, and a
call that should take seconds takes minutes.

`qwen3.5:4b` = 3292 MB. Fits comfortably. ~5x faster. Not failing.

**If the F1 holds, flipping the default extraction model is a one-line change with
a larger expected payoff than all the ranking work combined** — and it means you
may not need codex for distill at all (no ChatGPT-quota burn).

---

## What FEAT-487 proposes (gated on the diagnostic)

Three signals are **fully built, fully wired, and multiplied by zero**
(`src/config/config.ts:559,562,564`):

```
zeta  0   ENTITY relevance         OFF
eta   0   agent match              OFF
crossEncoder: { enabled: false }   reranker, BUILT, OFF   <- your slice
multiHop:     { enabled: false }   decomposition, BUILT, OFF
```

`search.ts` computes the entity bonus **only if it would count**:
`const entityBonus = zeta > 0 ? entityBonusForQuery(...) : undefined;` — and it
never counts.

**ζ=0 was CORRECT until today.** Entity extraction was ~87% broken; a ranking term
over a three-quarters-empty table is noise. Entity linkage is now **99.6%**. For
the first time there is real data under that weight, and the weight is zero.

**Cross-encoder (your likely focus):** `src/search/rerank.ts` is complete,
`enabled: false`, `topK: 50`, `timeoutMs: 300`. Reranking top-50 is the standard
+5-10 in retrieval and attacks `rank-miss` **directly** — and is near-worthless if
the diagnostic says `not-in-DB`.

⚠️ Measure **p95 recall latency**, not just the score. A +6 F1 that doubles recall
latency is a product decision, not a free win.

⚠️ `multiHop.provider` defaults to `'mock'`. Flipping `enabled` alone gets you a
mock decomposer. The real one costs an **extra LLM call per query** — latency AND
cost, not a config flip.

**Gate every result on the ADR-005 floors** (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7) AND
the LoCoMo per-category table. A headline win that regresses a category is not a
win.

---

## DO NOT

- **Do not touch `scripts/eval/locomo/answer.mts`'s prompt, model, or k.** It is the
  deliberately-fixed cheap answerer. Changing it inflates the score while telling
  you nothing about whether memory improved. (Adding *concurrency* is fine and
  already done — PR #253, score-neutral, pinned by test.)
- **Do not ship another temporal fix on the current theory.** Temporal is 0.1318
  (321 questions, the worst category). The fix built specifically for it — text-
  surface date grounding, PR #189 + #191 — moved essentially **nothing** (12.4 ->
  13.18). The standing diagnosis ("extraction gap, not schema gap") is therefore
  **in doubt**. Re-open the investigation before writing code. Three untested
  candidate explanations are listed in the research doc.
- **Do not run extraction on `qwen3:8b`** (see above).
- **Do not run two model-loading evals in parallel** — the 8 GB GPU cannot hold two
  LLMs; Ollama swaps per request and destroys both runs.
- **Do not kill processes by image name.** This box runs prod, eval daemons,
  Ollama, and sibling agents.

## Environment notes

- **Prod daemon is deliberately STOPPED** and its scheduled tasks (`AstraMemoryD`,
  `AstraMemoryDWatchdog`) are **DISABLED**, to keep the GPU quiet for the evals.
  Re-enable with `schtasks /change /tn AstraMemoryD /enable` (+ watchdog) and
  `node dist/cli/index.js service start`. Captures spool to disk meanwhile — no
  data loss.
- Released today: **v0.17.0** and **v0.17.1** (both on npm). v0.17.1 restores
  `reinstall --rollback`, which v0.17.0 broke.
- Ollama has `OLLAMA_KEEP_ALIVE=-1` — models never self-evict. Unload explicitly:
  `curl -X POST localhost:11434/api/generate -d '{"model":"qwen3:8b","keep_alive":0}'`

## Open PRs

- **#253** — LoCoMo answering concurrency (rebased, tsc clean, awaiting CI).
  42 of the 2h run was serial waiting on independent questions.

## Confidence / risks

- **High confidence:** LoCoMo is an extraction benchmark for us. 0.2362 -> 0.4610
  came almost entirely from 136 -> 2488 atoms, with the same retrieval code and
  the same answerer.
- **That is exactly why the diagnostic gates the ranking work.** The prior that
  ranking matters at all is weaker than it looks.
- **Realistic ceiling: ~+18 points, requiring ALL four categories.** No single
  lever is worth 20. FEAT-487 can credibly reach for +7 to +11 (single-hop +
  multi-hop) — and only if the diagnostic says `rank-miss`.
