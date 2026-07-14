# Retrieval diagnosis — the ranking work is worth ~1 point. Don't build it.

**Run:** `diagnose-retrieval.mts`, category 4 (single-hop), n=841, against the
completed full-suite eval store (2488 atoms, codex extraction, commit `429e99c`).
Production k=10, wide-limit 500, threshold 0.6.

**Correction (WS6, 2026-07-13):** the `rank-ok` ceiling below was originally
published as **+19.4**, computed as `386/1986` — i.e. it implicitly assumed
every one of the 386 `rank-ok` questions currently scores F1=0. That assumption
was never checked and is false: **31.1% of the bucket already scores F1=1.0**
and the bucket's mean F1 is **0.596**, not 0. The corrected ceiling is **+7.86**.
See "WS6: rank-ok re-measured" below for the full breakdown, the harness-
independent false-abstention figure, and why the "46% unreachable" verdict
still holds under the corrected number. The `not-in-db` and `rank-miss` rows
were not re-audited by WS6 and are unchanged, but see the soft-boundary note
below (#267) before treating any of this table's counts as exact.

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
| `rank-ok` | 386 | ~~+19.4~~ **+7.86 (corrected, WS6)** | **nobody — answerer / token-F1** |
| `not-in-db` | 344 | **+17.3** | **extraction** |
| `rank-miss` (all) | 111 | +5.6 | ranking |
| **`rank-miss` (verified)** | **19** | **+0.96** | **ranking — the honest number** |

`rank-ok`'s ceiling assumes every one of the 386 questions hits F1=1.0. That
premise was never true: 120/386 (31.1%) already score 1.0, mean F1 across the
bucket is 0.596, and only the non-perfect 266 records have any gap left to
close (sum of `1 - F1` across those 266 = 156.09, ÷ 1986 = the corrected
+7.86). The `not-in-db` and `rank-miss` ceilings above still use the original
(unaudited-by-WS6) "assume the whole bucket currently scores 0" method — that
premise happens to hold better there (a `not-in-db` or unranked `rank-miss`
question genuinely has no chance to score above ~0 today), but it has not been
independently re-verified the way `rank-ok` now has.

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
inside the top-10 the real answerer sees. **Correction (WS6): not all 386
"scored wrong"** — 31.1% already score F1=1.0. Of the 266 that don't, see "WS6:
rank-ok re-measured" below for the actual breakdown; the paragraph below still
describes the real dynamic for that non-perfect subset.

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

## WS6: rank-ok re-measured (2026-07-13)

The "46% unreachable" verdict above was asserted, not measured, when this doc
was first written. WS6 measured it: sampled 50 `rank-ok` records deterministically
across all 10 conversations (5 per conversation, indices 0/4/8/12/16 within
each conversation's own `rank-ok` list), pulled the real hypothesis from the
run's `hypotheses.jsonl`, the real atom text from the read-only
`memory.sqlite.pre-encryption.bak`, and scored everything with the actual
`containment`/`precision`/`f1Score` functions imported directly from
`diagnose-retrieval.mts` / `judge/metrics.mts` — no reimplementation. 13/50
(26%) already scored F1=1.0, consistent with the population's 31.1%, so the
sample is representative.

### F1 distribution across all 386 `rank-ok` records (population, not sample)

| F1 range | n | % |
|---|---|---|
| = 1.0 (perfect) | 120 | 31.1% |
| [0.7, 1.0) | 72 | 18.7% |
| [0.3, 0.7) | 90 | 23.3% |
| (0, 0.3) | 17 | 4.4% |
| = 0 | 87 | 22.5% |

Mean F1 = 0.596. This is the basis for the corrected +7.86 ceiling above.

### Failure-mode breakdown, n=37 non-perfect sample records (population: 266)

- **(C) Answerer failure — 17/37 (46%).** The largest class by far, and the
  reason the original "unreachable" call holds up. Sub-patterns, all with the
  supporting atom demonstrably correct and retrievable: false abstention (see
  below), truncation (answerer drops a clause the atom clearly has), wrong-
  clause selection (atom states two facts, answerer echoes the wrong one),
  over-synthesis across multiple atoms (answerer pads a terse-gold-answer
  question with true-but-extra detail from a second atom), and two outright
  factual errors (atom says "fantasy and sci-fi," hypothesis says "action and
  sci-fi").
- **(A) Verbosity/dilution — 5/37 (14%).** Atom bundles 2-5 distinct facts
  into one run-on sentence (worst case: 5 facts in 42 words). **Tested, not
  assumed:** hand-tightened single-fact rewrites of all 5 atoms, scored
  directly against gold with the real `f1Score`, scored *worse* on average
  (0.503 → 0.461 mean F1, 4 of 5 cases down or flat) — a tightened atom is
  still a full sentence, and its subject/verb/connective words don't overlap
  gold's bare noun-phrase answer any better than the original did. **Do not
  treat atom-splitting as a benchmark-score lever** on the strength of this
  sample; it may still be worth doing as ordinary memory hygiene (shorter
  atoms are cheaper in context, easier to read downstream), but that is a
  quality argument, not a score argument.
- **(B) Atom phrasing mismatch — 4/37 (11%).** Near-ceiling paraphrase
  differences or a genuine atom-content gap (an atom capturing "lost job →
  started dance studio" but dropping the transcript's "to share his passion"
  motivation clause).
- **(D) Genuinely unwinnable — 7/37 (19%).** Gold is a truncated subset of a
  more complete, equally-true atom (atom correctly adds "bond, support" to
  gold's "friendship, appreciation" — the atom is *more* right than gold, not
  less), or gold retains an idiosyncratic transcript phrase our atom
  reasonably dropped as subjective filler. Closing these would mean writing
  to gold's exact wording — scorer-fitting, out of bounds by design.
- **(E) Other — 4/37 (11%), two distinct findings, see the soft-boundary and
  coreference notes below.**

### The bucket boundary is soft — cross-reference #267

**2/50 sampled records (4%) are mislabeled `rank-ok`** — verified directly
against the DB, not just against the diagnostic's own score. `conv-30#47`
asks what Gina found for her physical store location; every atom about Gina's
store in the project describes it as an *online* store — no location-finding
fact exists anywhere. `conv-49#83` asks what car Evan replaced his broken
Prius with; the "got a new Prius" event was never captured as its own atom,
only the phrase "new Prius" appears incidentally in an unrelated Rockies-trip
atom. Both cleared the diagnostic's 0.6 containment + 0.12 short-answer-
precision guard purely on coincidental token overlap. **These are really
`not-in-db`, mislabeled `rank-ok`** — the true `not-in-db` count is a bit
higher than 344, the true `rank-ok` count a bit lower than 386.

This is the **same root cause** as **[#267](https://github.com/astragenie/astramem-local/issues/267)**
(open), which independently measured a 42% *false-negative* rate for this same
token-containment heuristic on the temporal category (`docs/research/20260713-temporal-grounding-regex-postmortem.md`).
#267 found the heuristic wrongly says "not found" too often; WS6 found it
wrongly says "found" too often. **Both directions are the same defect: crude
token containment doesn't verify the matched atom is actually *about* the
question, only that it shares enough words with the gold answer.** The
instrument shares the bias of the thing it measures. Neither `not-in-db`'s
344 nor `rank-ok`'s 386 should be read as exact until this heuristic is
replaced or independently audited — WS6 did not attempt that re-audit (2/50
is too small a sample to correct the population counts, only to flag that
they're soft).

### Coreference/entity-linking gap — the opposite lever from atom-splitting

`conv-42#90`: one atom states "Nate loves a favorite fantasy or sci-fi
trilogy" (unnamed); a separate atom states "Joanna watched The Lord of the
Rings after Nate recommended it" (named, but never framed as "his favorite").
No single atom states that Nate's favorite trilogy *is* Lord of the Rings —
the fact and its attribution live in two atoms that were never merged at
extraction time. This is the **opposite lever from (A) verbosity**: here the
fix would be to *merge* related atoms at extraction/consolidation time, not
split them. **There is no single "make atoms shorter" or "make atoms longer"
rule that fixes both classes of problem** — they require different mechanisms
(atomicity discipline for compound sentences vs. coreference resolution
across separate turns).

### Harness-independent figure: false abstention (JOB 1, diagnostic only — NEVER mixed with 0.4610)

**65/386 `rank-ok` records (16.8% of the bucket, 3.3% of all 1986) have a
hypothesis that is the literal string `"no information available"`** despite
`rank-ok` classification meaning a correct, on-topic atom was independently
confirmed at rank ≤10 in the production-matched candidate pool. This is not a
memory failure — the retrieval worked. `answer.mts` stays frozen; this figure
does not change 0.4610 and must never be reported alongside it as if it did.

Method: for all 65, re-queried the DB directly for the atom achieving the
highest gold-token containment (same method as the main sample, unmodified
atom text — no hand-tightening this time), then scored that atom's raw text
against gold with the real `f1Score`. A qualifying atom was found for all
65/65 (0 misses on re-query).

| | current F1 | atom-text-as-answer F1 (offline, harness-independent) |
|---|---|---|
| mean | 0.000 | **0.410** |

Distribution of the atom-as-answer F1 (n=65): 0% at 0 (every single one of the
65 has *some* genuine token overlap with gold — none are spurious), 30.8% in
(0, 0.3), 63.1% in [0.3, 0.7), 6.2% in [0.7, 1.0), **0% at 1.0**. So: the
evidence was genuinely relevant in all 65 cases (confirms the abstentions were
wrong as a binary "is the information there" call) — but it was not "worth
~1.0" if used verbatim; the same sentence-scaffolding precision penalty from
the (A) test above applies here too, so the honest recoverable value is
**mean 0.410, not near-perfect**. If the harness used this offline figure
instead of the answerer's literal output, the notional gain across the full
1986-question set would be **+1.34 points** — reported here as a diagnostic
characterizing memory quality, not as a benchmark score, and not actionable
while `answer.mts` is frozen.

One of the 65 is `conv-30#47`, the same record flagged above as a likely
classifier false positive — its atom-as-answer F1 (0.207) is on the low end
of the distribution, consistent with it being a coincidental match rather
than genuine evidence. This is a useful cross-check: the figure isn't
inflated by including cases that shouldn't be counted as "evidence" at all.

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
