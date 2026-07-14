# Handoff — extraction is the lever. Ranking is worth ~1 point.

**Supersedes** `20260714T0030Z-handoff-reranking-and-retrieval-investigation.md`
(that one recommended ranking work; the diagnostic then killed it — read this
one instead).

**Objective for you:** find out why **344 facts never reached the store**, and fix
it. That is **+17.3 points** of ceiling. Everything else is smaller or unreachable.

---

## 1. Where we are

First **full-suite** LoCoMo run (n=1986 — every prior number in this repo came
from ONE conversation, n=199):

```
1 (multi-hop)   : 0.3145   (282)
2 (temporal)    : 0.1318   (321)   <- worst, and unexplained
3 (open-domain) : 0.2318   (96)
4 (single-hop)  : 0.4332   (841)   <- 42% of the benchmark
5 (adversarial) : 0.8924   (446)

Category-averaged : 0.4007
Overall (F1)      : 0.4610   n=1986
```

**Read the categories, not the headline.** The overall is flattered by adversarial
(446 questions where abstaining is correct, scored binary). **A system with no
memory at all scores ~22 by abstaining on everything.** Category-averaged 0.4007
is the honest number.

Provenance: commit `429e99c`, codex extraction (`gpt-5.4-mini`), qwen3:8b
compaction, conversational profile, k=10, **answerer unmodified**. 2488 atoms,
99.6% entity linkage, 0 poison.

Docs: `docs/research/20260713-locomo-full-suite-result.md`

---

## 2. THE FINDING — read this before planning anything

The retrieval diagnostic (`diagnose-retrieval.mts`, category 4, n=841) buckets
every single-hop miss:

```
rank-ok    386  (46%)   retrieved in top-10, STILL answered wrong
not-in-db  344  (41%)   never extracted
rank-miss  111  (13%)   ...but only 19 are VERIFIED (83% unverified)
```

Max overall-F1 gain if each bucket were **perfectly** fixed, across all 1986:

| bucket | n | ceiling | owner |
|---|---|---|---|
| `rank-ok` | 386 | **+19.4** | **nobody — answerer / token-F1** |
| `not-in-db` | 344 | **+17.3** | **EXTRACTION — this is your job** |
| `rank-miss` (all) | 111 | +5.6 | ranking |
| **`rank-miss` (verified)** | **19** | **+0.96** | ranking — the honest number |

### What this means

**Ranking is dead.** Perfect reranking buys ~1 point, chasing 19 verified
questions out of 1986. **FEAT-487 (ζ + cross-encoder + multi-hop decomposition) is
marked `declined`.** It budgeted 12-18h and estimated +7 to +11. Both were wrong.
A 1-hour gate killed it.

**`rank-ok` (386) is the LARGEST bucket, and it is not a memory problem.** The
correct memory *was retrieved*, inside the top-10 the real answerer sees, and the
answer still scored wrong. That's the deliberately-fixed cheap answerer
(`gpt-5-mini`, minimal reasoning, 150 tokens) plus **token-F1** — a correct fact,
worded differently, scoring near zero. **~46% of the single-hop gap is unreachable
by anything we build.** Chasing it by strengthening the answerer inflates the score
while telling us nothing; that's how vendors publish 70s.

**Extraction is the only real lever.** Consistent with everything else:

```
0.2362 -> 0.4610      same answerer, same retrieval code
  136  -> 2488 atoms  (18x)
```

The score has **always** tracked what we store, not how we rank.

Docs: `docs/research/20260713-locomo-retrieval-diagnosis.md`
Per-question detail: `docs/research/20260713-locomo-retrieval-diagnosis-singlehop.json`

---

## 3. YOUR WORK, in priority order

### (a) Why did 344 facts never get extracted? — the +17.3

**Start here.** The per-question JSON is committed. Filter
`classification == "not-in-db"` and **find the pattern.**

- 197 are `short_answer: true` — gold answer ≤2 tokens, weaker containment signal.
  **Discount these; the tool says so itself.**
- **147 are solid** (long gold answer, real miss). **These are the ones to explain.**

Questions worth asking of that set: are they a *type* of fact (dates? numbers?
relationships? negations?) — a *position* in the conversation (buried mid-session?
in a long turn?) — or a *chunking* artifact (split across a chunk boundary and lost
by both halves)? Read 20 of them by hand before writing any code.

### (b) The extraction model — possibly a one-line fix

**`qwen3:8b` — the SHIPPED DEFAULT — is measurably broken.**

- Real eval: **4 jobs in 20 minutes**, 3 poisoned, timeouts.
- The extraction bench **already in this repo** records it at **20 failed fixtures,
  154.5s/session, no F1 at all**
  (`scripts/eval/extraction-bench/results/qwen3-live-2026-07-13/report.md`).
- **The evidence existed and nobody ran it.** `built-wired-never-invoked`, pointed
  at our own evaluation tooling.

**Root cause: VRAM.** RTX 5060 Laptop, 8151 MiB. `qwen3:8b` = 5896 MB resident +
embedder 590 MB. `num_ctx` is sized per call (cap 16384), so a big prompt pushes
past VRAM, **Ollama spills layers to CPU**, and a seconds-long call takes minutes.

`qwen3.5:4b` = 3292 MB. Fits. **~5x faster. Not failing.**

**In flight (I am running these — do not duplicate):**
- 3-run `qwen3.5:4b` extraction bench (43 fixtures x 3; `--runs 3` is mandatory —
  a single run has a **±14 F1 swing**, FEAT-450). Run 1: 43 fixtures, 128 atoms,
  mean 3.0/fixture, **zero crashes**.
- codex vs `qwen3.5:4b` extraction A/B on LoCoMo (`--n 3`, same seed, compaction
  held constant at `qwen3.5:4b`, sequential). Worktree:
  `astramemory-local-wt-ab-extract`.

**If the F1 holds, changing the default extraction model is a one-line change with
a bigger payoff than all the ranking work combined** — and may mean we don't need
codex for distill at all (no ChatGPT-quota burn).

### (c) Temporal (0.1318) — re-diagnose, do NOT re-fix

Worst category, 321 questions. It was 12.4. Text-surface date grounding (#189 +
timezone fix #191) shipped **specifically** to fix it and moved **essentially
nothing** (12.4 -> 13.18).

**The standing diagnosis — "temporal is an extraction gap, not a schema gap"
(concluded by a full architecture investigation) — is therefore IN DOUBT.** The fix
derived from that theory **failed**.

**Do not ship a third temporal fix on the same theory.** Three untested candidate
explanations are listed in `docs/research/20260713-locomo-full-suite-result.md`.
Distinguishing them is a **measurement** problem, not a coding problem. Measure
first — exactly like the diagnostic just did to the ranking plan.

### (d) `rank-ok` (386) — worth understanding, not gaming

If ~19% of the benchmark is unwinnable by design, **that changes what "good" means
here.** Worth an investigation to size honestly. **Not** by strengthening the
answerer — that inflates the score and measures nothing.

### (e) ζ — the one survivor from FEAT-487

Flip it and measure. **One config value.** Entity linkage went from 87%-broken to
**99.6%**, so for the first time there is real data under that weight
(`zeta: 0` in `src/config/config.ts:559`; `search.ts` even computes the entity
bonus *only if it would count* — and it never counts).

**Cheap flip-and-measure, not a week.** Ceiling is now known to be ~1 point. Gate
on the ADR-005 floors (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7) AND the per-category table.

---

## 4. HARD RULES

- **Do not touch `scripts/eval/locomo/answer.mts`'s prompt, model, or k.** It is the
  deliberately-fixed cheap answerer. Changing it inflates the score while telling
  you nothing about whether memory improved. (Adding *concurrency* was fine and is
  already merged — PR #253, score-neutral, pinned by test.)
- **Do not run extraction on `qwen3:8b`** — see above.
- **Do not run two model-loading evals in parallel.** The 8 GB GPU cannot hold two
  LLMs; Ollama swaps per request and destroys both runs. Sequence them.
- **Do not kill processes by image name** (`taskkill /IM node.exe`, `Stop-Process
  -Name node`). This box runs prod, eval daemons, Ollama, and sibling agents. Kill
  only PIDs you spawned.
- **Do not `git stash`** — the stash stack is repo-global across worktrees.
- **Migration numbers:** take from `git ls-tree origin/main migrations/ | tail -1`
  **immediately before pushing**. Never from a message, never from a green CI check
  on a stale base. Nine collisions in one day; one bricked prod.

## 5. Environment

- **Prod daemon is deliberately STOPPED**, and its scheduled tasks (`AstraMemoryD`,
  `AstraMemoryDWatchdog`) are **DISABLED**, to keep the GPU quiet for the evals.
  Restore: `schtasks /change /tn AstraMemoryD /enable` (+ watchdog), then
  `node dist/cli/index.js service start`. Captures spool to disk meanwhile — no
  data loss.
- **Live daemon on the completed eval store:** port **7899**, token
  `diag` + 56 zeros, datadir
  `astramemory-local-wt-locomo-postfix/.eval-data/locomo/runs/20260713-codex-qwen/datadir`
  (2488 atoms). Re-run the diagnostic per category with `--category N`.
- **Work in your own worktree** so we don't collide.
- Ollama has `OLLAMA_KEEP_ALIVE=-1` — models never self-evict. Unload explicitly:
  `curl -X POST localhost:11434/api/generate -d '{"model":"qwen3:8b","keep_alive":0}'`
- Released today: **v0.17.0** and **v0.17.1** (both on npm). v0.17.1 restores
  `reinstall --rollback`, which v0.17.0 broke.

## 6. Confidence

- **High:** LoCoMo is an extraction benchmark for us. Ranking is worth ~1 point.
  Both are measured, not argued.
- **Medium:** that `qwen3.5:4b` is a viable default extractor — bench in flight,
  run 1 clean, F1 pending.
- **Unknown:** why temporal didn't move. **Treat the standing explanation as
  disproven until re-measured.**

## 7. The meta-lesson, because it will save you a week

**The plan I wrote an hour ago was reasonable, well-argued, and wrong.** What saved
it was making the diagnostic a **gate** with an explicit **kill condition**, and
then honouring it. A 1-hour measurement killed 12-18 hours of work worth one point.

**Measure before you build.** Especially when the plan feels obviously right.
