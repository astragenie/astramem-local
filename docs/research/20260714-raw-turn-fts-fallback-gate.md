# Raw-turn FTS fallback — gate experiment (2026-07-14)

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

## GO / KILL

**GO, conditionally.** 55% at k=10 clears the architect's own ">50%" bar for
"the fallback tier is real, worth building." Even discounting for the small
sample (n=20, itself drawn from one conversation-set's 344-record bucket,
itself one eval run — same "modest cross-validation, not full-sample
confirmation" caveat WS2 already carries), the result is not the paraphrase
wipeout the architect's own kill condition worried about. Lexical FTS is
not useless here — LoCoMo gold answers, even when paraphrased relative to
the *question*, are frequently near-verbatim relative to the *source turn*
(the gold answer is usually lifted or lightly reworded from the turn text
itself, even when the question is phrased differently) — so turn-level FTS
against the question text still finds real matches on tokens the question
and the turn share independently (names, objects, activities).

**This is a lower bound, not a ceiling.** The embedding half of this gate
was not run — `curl localhost:11434/api/ps` showed `qwen3.5:4b` and
`mxbai-embed-large` both loaded, consistent with the in-flight extraction
bench in this environment's task state, and the gate's hard constraint was
to defer the GPU-contending half rather than run it against a busy card.
Embedding similarity would very likely rescue some or all of the 9 lexical
misses above (several — conv-26#89, conv-48#58 — are clean paraphrase
misses with near-zero token overlap but obvious semantic overlap), so the
true hit rate for a hybrid FTS+vector fallback is understated here, not
overstated.

## The residual risk — named, not resolved

Both the team lead and the architect flagged the same open question and
this experiment cannot close it: **a rescued fact moving from `not-in-db`
to "findable at k=10" does not guarantee it moves to a correct score.**
WS6 (`docs/research/20260713-single-hop-root-cause.md`'s sibling rank-ok
investigation, PR #274) measured that 46% of the "retrieved but scored
wrong" `rank-ok` bucket is the frozen cheap answerer abstaining, truncating,
or picking the wrong clause on evidence that was already at rank 1 — an
atom, not a raw turn. A raw conversational line ("You're doing something
amazing! Creating a family for those kids is so lovely.") is structurally
less clean than a compacted atom, and the same answerer that already
mishandles 46% of clean atom evidence may handle noisy turn evidence worse,
not better. **This experiment measures findability, not answerability** —
exactly the distinction the architect's design already anticipates with the
"distinct trust tagging" mitigation in §5 of the structural review, but
that mitigation is unbuilt and untested. A prototype is the only way to
close this gap; it cannot be measured offline.

## What this does and doesn't justify

- Justifies: prototyping the architect's gated fallback tier (fires only
  when the atom pool is empty/weak, never fused into the main ranked pool)
  as a live experiment, with the fire-rate canary the architect's §8
  already specifies as a same-slice requirement, not a follow-up.
- Does not justify: assuming the fallback closes 55% of the `not-in-db`
  gap in final LoCoMo score. That number describes *retrievability*, not
  *answer correctness*, and WS6's 46%-frozen-answerer-failure finding is
  the reason those two are not the same thing.
- Does not justify: skipping the vector half of this gate. It was deferred
  for GPU contention, not run and found unnecessary — re-run it once the
  card is free, before sizing the fallback's design around FTS alone.

## Reproduction

Throwaway script, not committed (per the gate's "no build" constraint):
read `diagnosis-singlehop.json`, group `not-in-db` records by `sample_id`,
take first 5/conversation in file order, classify via unstemmed token
containment against `memories.text` (threshold 0.6/0.3, manual read of the
0.3–0.6 band), then build a per-conversation in-memory FTS5 index over
`transcripts.content` turns and query with the gold question text via
`bm25()`-ranked `MATCH`. Data paths and exact thresholds are reproducible
directly from this doc; the script itself was scratch, per the "no
residue" convention WS2 already established for this class of throwaway
diagnostic.
