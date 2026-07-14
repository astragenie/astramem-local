# Retrieval diagnosis — the ranking work is worth ~1 point. Don't build it.

**Run:** `diagnose-retrieval.mts`, category 4 (single-hop), n=841, against the
completed full-suite eval store (2488 atoms, codex extraction, commit `429e99c`).
Production k=10, wide-limit 500, threshold 0.6.

## Result

```
single-hop  n=841
  rank-ok    386  (46%)   retrieved in top-10, STILL answered wrong
  not-in-db  344  (41%)   never extracted
  rank-miss  111  (13%)   extracted, ranked below k=10
                          ...but 92 of those (83%) are UNVERIFIED
                             only 19 are solid
```

## What each bucket is worth, if PERFECTLY fixed

Expressed as max overall-F1 gain across the full 1986-question benchmark:

| bucket | n | ceiling | who owns it |
|---|---|---|---|
| `rank-ok` | 386 | **+19.4** | **nobody — answerer / token-F1** |
| `not-in-db` | 344 | **+17.3** | **extraction** |
| `rank-miss` (all) | 111 | +5.6 | ranking |
| **`rank-miss` (verified)** | **19** | **+0.96** | **ranking — the honest number** |

## The verdict: FEAT-487 is CLOSED

FEAT-487 proposed turning on ζ (entity relevance), the cross-encoder reranker, and
multi-hop query decomposition — all built, all wired, all multiplied by zero. It
budgeted **12-18 hours** and estimated **+7 to +11 points**.

It also wrote its own kill condition:

> *"if `not-in-DB` dominates single-hop misses, **close this FEAT** and put the
> effort into extraction. Say so plainly rather than shipping ranking work that
> cannot help."*

**`not-in-DB` (344) beats `rank-miss` (111) by 3:1 — and 83% of the rank-misses
are unverified.** Perfect reranking buys **~1 point**, chasing **19 verified
questions out of 1986**.

**A 1-hour diagnostic killed 12-18 hours of work that would have moved the score
by about one point.** That asymmetry was the entire design of the gate, and it
paid for itself on first use.

The `rank_verified` caveat is the diagnostic's own (`unverified_rank_n`'s doc
comment: *"a category whose rank-miss count is mostly unverified is a weaker
signal than one confirmed against the real candidate pool"*). Do not quote the
111 without the 19.

## The finding that reframes the whole benchmark

**`rank-ok` = 386 is the LARGEST bucket.** The correct memory **was retrieved**,
inside the top-10 the real answerer sees, and the answer **still scored wrong**.

That is **not a memory failure.** It is the deliberately-fixed cheap answerer
(`gpt-5-mini`, `reasoning_effort: minimal`, 150 tokens) plus **token-F1** — a
correct fact, worded differently, scoring near zero. Our own earlier analysis
found ~1/3 of "when" gold answers are phrased relative to another date, penalised
**even when the fact is right**.

So the single-hop gap decomposes as:

- **46% unreachable** by anything we build (answerer / metric)
- **41% extraction**
- **2% ranking** (verified)

**If ~19% of the benchmark is unwinnable by design, that changes what "good" means
here.** Worth its own investigation — not to game the metric, but to know how much
of the "gap" is real. Chasing `rank-ok` by strengthening the answerer would inflate
the score while telling us nothing about whether memory improved; that is how
vendors publish 70s.

## What to do instead

**Extraction is the only real lever.** 344 facts never reached the store. That is
consistent with everything else we know:

```
0.2362 -> 0.4610      same answerer, same retrieval code
  136  -> 2488 atoms  (18x)
```

The score has always tracked **what we store**, not **how we rank**.

Highest-value work, in order:

1. **The extraction model.** `qwen3:8b` — the *shipped default* — is measurably
   broken (4 jobs in 20 min in the real eval, 3 poisoned; and the in-repo
   extraction bench already records it at **20 failed fixtures, no F1**). A
   codex-vs-`qwen3.5:4b` A/B is in flight.
2. **Why 344 facts were never extracted.** The diagnosis file
   (`20260713-locomo-retrieval-diagnosis-singlehop.json`) carries per-question
   detail — read the `not-in-db` records and find the pattern. 197 of them are
   short-answer (weaker containment signal); **147 are solid**.
3. **Temporal (0.1318)** — still the worst category, still unexplained, and the
   fix built for it did nothing. Separate investigation.

**ζ is still worth a one-config-value experiment** (entity linkage went 87%-broken
to 99.6%, so there is real data under that weight for the first time). But it is a
*cheap flip and measure*, not a week of work, and its ceiling is now known to be
about a point.

## Caveats on this diagnosis, stated because the tool states them

- **Short-answer records (337 of 841):** a gold answer stemming to 1-2 tokens makes
  pure containment nearly meaningless. The tool guards with a minimum precision
  (0.12) and **reports the count separately** so it can be spot-checked rather than
  silently folded in. 197 of the 344 `not-in-db` are short-answer.
- **Unverified rank (92 of 111 rank-misses):** rank not confirmed against the real
  k=10 candidate pool. This is why the honest rank-miss number is **19**, not 111.
- **Multi-hop bucketing is directionally useful only** (per the tool's header) —
  a question needing two memories can read as `not-in-db` even when each fragment
  is individually retrievable. This diagnosis is single-hop, where the bucketing is
  precise.
