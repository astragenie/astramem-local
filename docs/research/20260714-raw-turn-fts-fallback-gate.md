# Raw-turn FTS fallback — gate experiment (2026-07-14)

**Verdict: KILL.** Findability is high (55% hit@10) but answerability is
not (0.137 mean turn-as-answer F1, real scorer — a third of WS6's own
atom-text-as-answer proxy of 0.410, below the team lead's 0.3 kill line).
See "GO / KILL" below for the full reasoning; this doc's early sections
were written before that number existed and are kept for the audit trail.

Status: **gate result, read-only, no code changed**. Requested by team lead as
a cheap offline test before funding the architect's §6 fallback-tier
proposal (`docs/research/20260714-architect-atom-primitive-structural-review.md`).

## The question

The architect's structural review found `transcripts.content` (the full,
stage-0-redacted, ingested dialogue) is stored but never searched — the only
readers in the whole codebase are two `SELECT id` idempotency checks in
`ingest.ts`. The proposal: a gated fallback tier that queries the raw
transcript only when the atom pool is empty/weak. Before funding a build,
the architect's own §6 named the cheap kill test: **would keyword search
over the raw turns actually have surfaced the facts extraction lost, at a
top-10 window?**

This is that test.

## Method

Zero GPU, zero LLM calls, entirely offline against data already on disk.
Read-only Python (`sqlite3`, stdlib FTS5) against
`astramemory-local-wt-locomo-postfix/.eval-data/locomo/runs/20260713-codex-qwen/`:
`diagnosis-singlehop.json` (WS2's `diagnose-retrieval.mts` output, 841
category-4/single-hop records) and `datadir/memory.sqlite.pre-encryption.bak`
(the real ingested/distilled plaintext store for that run — the live
`.sqlite` is SQLCipher-encrypted).

### Step 1 — sample, mirroring WS3's exact method

Filtered `classification == "not-in-db"` (344 of 841 records). Took the
first 5 records per conversation in file order across all 10 conversations
— **50 records**, the identical deterministic sampling method issue #273
describes ("5 per conversation, first-in-file-order, all 10 conversations
covered"). WS3's own per-record qa_id list was never published (checked the
issue, its comments, the WS3 worktree, and PR #269/#274 — only aggregate
percentages exist), so this is an independent reproduction of their method
against the same underlying data, not a reuse of their exact sample.

### Step 2 — exclude false negatives (the #267 contamination)

Issue #267 established that `diagnose-retrieval.mts`'s `not-in-db`
classifier is a token-containment heuristic and produces false negatives:
a fact stored correctly but worded differently from gold gets bucketed
`not-in-db` even though it's actually retrievable. Testing FTS rescue on
those would be meaningless — they were never lost. For each of the 50
sampled records, computed unstemmed lowercase-token containment (gold
answer tokens found in each atom's text, stopwords removed) against every
atom in that record's conversation, using the same 0.6 threshold #267 uses:

| bucket | n | % |
|---|---|---|
| Likely false negative (overlap ≥ 0.6, fact already stored, different words) | 28 | 56% |
| Borderline (0.3 ≤ overlap < 0.6) — hand-read | 11 | 22% |
| Genuinely missing (overlap < 0.3) | 11 | 22% |

Hand-read all 11 borderline records (question + gold answer + best-matching
atom text, printed by the script). 2 were the same fact restated in
different words (false negative, e.g. conv-41#76: gold "saw the impact he
could make in the community through politics" vs. stored atom "John is
running for office because he wants to serve his country and community and
make an impact" — same fact). The other 9 were a different topic sharing an
incidental token, or a partial extraction (e.g. conv-48#16: gold asks for
two snake names, "Susie, Seraphim"; only "Susie" was ever stored — the
question can't be fully answered from what's there).

**Final split: 30/50 (60%) false negative, 20/50 (40%) genuinely missing.**
This is the same order of magnitude and same direction as #267's
independently-measured 42% false-negative rate on its own 50-question
sample — the discrepancy (60% vs 42%) is expected: this pass used a looser
unstemmed substring check with no precision guard (vs. #267's stemmed
`containment`/`precision` machinery), and folds in 2 of my own
manually-judged borderline calls. Both measurements point the same
direction: **not-in-db is heavily contaminated by false negatives, and any
FTS-rescue test must exclude them or the number is meaningless.**

### Step 3 — FTS test on the genuinely-missing 20

For each of the 20 genuinely-missing records: built a throwaway in-memory
SQLite FTS5 index (`CREATE VIRTUAL TABLE turns USING fts5(body)`) over every
turn (`{role, text}` entry) across **all sessions of that question's
conversation** (turn granularity — parsed straight out of
`transcripts.content`'s JSON array, not whole-transcript), queried with the
tokenized gold question text (`OR`-joined FTS5 MATCH, ranked by `bm25()`),
and checked whether the turn matching the gold `evidence` field (`D{n}:{m}`
→ session `n`, turn `m`) landed in the top 10.

Spot-verified the mechanism directly against raw data before trusting the
aggregate number: confirmed one hit (`conv-48#64`, "Does Deborah like
cats?" — short generic query, unsurprising hit) and one miss
(`conv-26#89`, "What does Melanie think about Caroline's decision to
adopt?" — gold turn text is *"You're doing something amazing! ... You'll
be an awesome mom!"*, which shares essentially zero tokens with the
question; the word "adopt" never appears in the turn at all) by hand —
both are genuine, not an off-by-one or query-construction bug. (One real
bug *was* caught and fixed mid-run: the diagnosis JSON's `sample_id` field
is bare `conv-26`, but `transcripts.session_id`/`memories.session_id` are
prefixed `locomo-conv-26-s1` — the unprefixed first pass silently returned
zero rows everywhere and produced a suspicious clean 0%, which is what
flagged the bug.)

## Result

**11/20 = 55.0% top-10 hit rate** on the genuinely-missing, false-negative-excluded
sample.

| qa_id | question (abridged) | hit@10 |
|---|---|---|
| conv-26#89 | Melanie's opinion on Caroline adopting | miss |
| conv-30#45 | Jon's attitude toward the dance festival | **hit** |
| conv-42#88 | Joanna's favorite movie | miss |
| conv-42#91 | Nate's favorite book series topic | miss |
| conv-43#91 | when John met teammates after his trip | **hit** |
| conv-44#64 | Audrey's tattoo flowers | miss |
| conv-47#71 | what James offered John re: pets | miss |
| conv-48#58 | games Jolene recommends Deborah | miss |
| conv-48#59 | what Deborah + husband do together | **hit** |
| conv-48#64 | does Deborah like cats | **hit** |
| conv-49#95 | what the smartwatch helps Evan with | miss |
| conv-26#86 | who the adoption agency supports | **hit** |
| conv-30#44 | what Gina says about dancers in photo | miss |
| conv-41#74 | why Maria sat with the girl at the shelter | **hit** |
| conv-42#92 | Nate's gaming-room lighting | **hit** |
| conv-44#62 | what Andrew misses about trail walks | **hit** |
| conv-48#16 | names of Jolene's snakes | **hit** |
| conv-48#42 | music Deborah plays during yoga | **hit** |
| conv-49#86 | Evan's advice to Sam on finding passion | miss |
| conv-50#80 | how Calvin jumpstarts his inspiration | **hit** |

## Findability is not the bar — answerability is. Recalibrated after review.

55% at k=10 clears the "is it findable" bar, but the team lead correctly
raised the bar mid-experiment: a fact moving from `not-in-db` to
"findable" is worthless if the frozen F1-scored answerer can't turn what it
finds into a correct-looking answer. WS6 already measured the closest real
proxy for that — feeding a **correct, rank-≤10 atom's own text** as the
literal answer scores a mean F1 of **0.410** against gold (PR #274's
harness-independent diagnostic, 65 false-abstention cases). That's the bar
a raw-turn rescue has to clear, not "was it found."

### Step 4 — score raw-turn-as-answer F1 with the real scorer

For each of the 11 hits, fed the **evidence turn's own raw text** (exactly
as WS6 fed the atom's own text — no answerer LLM in the loop, a direct
harness-independent proxy) through the actual `f1Score` imported from
`scripts/eval/locomo/judge/metrics.mts` (not reimplemented — same Porter
stemmer, same `normalizeAnswer`, same code the real score uses). For
multi-evidence facts (e.g. two snake names in two different turns), both
turns' text were concatenated as the candidate answer, matching what a
real k=10 retrieval window would hand the answerer.

| qa_id | gold | turn-as-answer F1 |
|---|---|---|
| conv-30#45 | "Glad" | 0.200 |
| conv-43#91 | "Aug 15th" | 0.039 |
| conv-48#59 | "play detective games together, spend time outdoors and explore nature" | 0.474 |
| conv-48#64 | "Yes" | 0.039 |
| conv-26#86 | "LGBTQ+ individuals" | 0.100 |
| conv-41#74 | "The girl seemed sad and had no other family" | 0.230 |
| conv-42#92 | "red and purple lighting" | 0.000 |
| conv-44#62 | "The peaceful moments" | 0.077 |
| conv-48#16 | "Susie, Seraphim" | 0.051 |
| conv-48#42 | "Savana, Sleep" | 0.070 |
| conv-50#80 | "explore other things and have some fun" | 0.222 |

**Mean turn-as-answer F1 across the 11 hits: 0.137.**

This is roughly **a third of WS6's atom-proxy baseline (0.410)** and
squarely below the team lead's own 0.3 kill line. The mechanism is
visible in every row above: a raw turn is full-sentence conversational
prose ("John: Hey Tim! We had a wild few days... I met back up with my
teammates on the 15th after my trip and it was amazing!... I'm so lucky to
be a part of this team!" for gold `"Aug 15th"`, F1 0.039) — CLAUDE.md's own
verbosity-tax finding (~11 F1 points lost on already-compacted *atoms*)
compounds severely on raw dialogue, which is far more verbose and far less
targeted than even an uncompacted atom. **`conv-42#92` scores exactly
0.000** — the correct turn was retrieved (mentions Nate dyeing his hair
purple and shows a gaming-room photo) but shares zero stemmed tokens with
gold `"red and purple lighting"` once article-stripping and stemming run;
findable and worthless are not mutually exclusive.

### Step 5 — does the chunk-size fix already claim this bucket?

WS7 independently confirmed (issue #273) that chunks over ~2800 chars
systematically lose content from their first half to recency bias, and
that fixing it recovers facts as clean atoms at near-zero cost — a
strictly better outcome than a raw-turn fallback for anything it can
reach. Ran the **real** `chunk()` function
(`src/distill/stages/03-chunk.ts`) against each of the 20 genuinely-missing
facts' source session (via `flattenTranscriptContent`, matching the real
pipeline's own preprocessing), located each evidence turn's chunk and its
fractional position within that chunk's turn range, and flagged
"chunk-fix territory" using WS7's own pattern (chunk >2800 chars, turn
position <0.5):

**4/20 (20%) sit in chunk-fix territory** — `conv-43#91`, `conv-48#58`,
`conv-48#64`, `conv-49#95`. Excluding them (WS7's fix reaches these facts
more cheaply and produces a clean atom, not a noisy raw turn):

- Residual addressable set: **16 records**
- Residual FTS hit rate: **9/16 = 56.3%** (essentially unchanged — the
  chunk-fix overlap wasn't concentrated in either hits or misses)
- Residual mean turn-as-answer F1 (hits only): **0.158** (n=9) — still
  far below the 0.3 kill line

The chunk-size overlap doesn't change the verdict. It narrows the
addressable set modestly (16 of 20, not 20 of 20) but the answerability
problem is the dominant one either way.

## GO / KILL — **KILL**

**KILL the raw-turn-fallback proposal as scoped.** Findability alone
(55%, or 56.3% after excluding the chunk-fix's territory) is not the
right bar — the team lead's recalibration was correct. Turn-as-answer F1
(0.137 overall, 0.158 on the chunk-fix-adjusted residual) is roughly a
third of WS6's already-modest atom-text-as-answer proxy (0.410) and
clears neither an intuitive "is this worth anything" bar nor the explicit
0.3 kill line. This is not the paraphrase gap (the architect's originally
named risk) — FTS found the right turn more than half the time. It's the
**second risk the architect's own §5 named and did not resolve**: "a
cheap answerer may not be able to use an unstructured excerpt the way it
uses a structured atom." That risk materialized, decisively, once
measured instead of assumed.

**Concretely: this would spend real build cost (redaction re-audit, a new
FTS5 index over `transcripts`, a fire-rate canary, `fuse.ts` isolation
work) to move facts from "absent" to "present but still scoring ~0.14 F1
on average" — the architect's own §7 kill condition ("this would mean the
fallback mostly succeeds at turning `not-in-db` into `rank-miss`... which
is strictly worse than doing nothing") is what actually happened, just one
layer further down the causal chain than the kill condition's own wording
anticipated (not a *retrieval-rank* miss — an *answer-quality* miss, on
facts that WERE found).**

## What's left standing, and what isn't

- **Killed:** the raw-turn FTS/vector fallback tier as scoped in the
  architect's §6/§7 proposal. Do not prototype it. The findability number
  (55%) is real but is not the number that matters — answerability is,
  and it fails by a wide margin (0.137 vs. a 0.3 floor, vs. a 0.410
  atom-proxy ceiling).
- **Not killed, separately:** WS7's chunk-size fix. It reaches a
  meaningful, if here modest (4/20 = 20% of this sample), slice of the
  same missing-fact bucket at near-zero cost and produces a clean,
  structured, dedup'd atom — not a noisy raw turn scoring 0.137. Nothing
  in this experiment argues against shipping it; if anything, it's now
  the *only* mechanism on the table that reaches part of this bucket at a
  cost/benefit ratio that clears the bar the raw-turn fallback just
  missed.
- **Not answered, and now moot:** the vector-search half of the original
  gate. It was deferred for GPU contention and is no longer worth running
  — a better *retrieval* mechanism (embeddings would very likely raise the
  55%/56.3% hit rate) does not fix an *answerability* problem measured
  independently of how the evidence was retrieved. Improving retrieval
  recall on a fallback whose answerability ceiling is ~0.14 F1 is not
  where the next hour of GPU time should go.

## Reproduction

Two throwaway scripts, neither committed (per the gate's "no build"
constraint, and WS2's "no residue" convention for this class of
diagnostic):

1. **Python/sqlite3** — read `diagnosis-singlehop.json`, group `not-in-db`
   records by `sample_id`, take first 5/conversation in file order,
   classify via unstemmed token containment against `memories.text`
   (threshold 0.6/0.3, manual read of the 0.3–0.6 band), then build a
   per-conversation in-memory FTS5 index over `transcripts.content` turns
   and query with the gold question text via `bm25()`-ranked `MATCH`.
2. **bun/TypeScript** (`bun:sqlite`) — imported the real `f1Score` from
   `scripts/eval/locomo/judge/metrics.mts` and the real `chunk()` +
   `flattenTranscriptContent()` from `src/distill/stages/03-chunk.ts` /
   `src/distill/flatten-turns.ts` directly (no reimplementation), scored
   each hit's evidence-turn text against gold, and computed each evidence
   turn's fractional position within its real chunk.

Data paths, exact thresholds, and the qa_id-level result table are
reproducible directly from this doc.
