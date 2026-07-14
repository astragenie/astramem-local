# Handoff — extraction recall: the plan, from six competitor teardowns

**Objective:** recover the **344 facts that never became atoms** (+17.3 points of
ceiling). That is the only real lever we have.

**Read these two first, in order** (both merged, PR #265):
1. `docs/research/20260713-locomo-retrieval-diagnosis.md` — why ranking is dead
2. `docs/research/20260714-competitor-teardown-six-repos.md` — what to steal

---

## 0. The three facts that determine everything you do

**(a) Ranking is worth ~1 point. Do not build it.**

```
single-hop  n=841
  rank-ok    386  (46%)   retrieved in top-10, STILL answered wrong  -> answerer/token-F1, NOT US
  not-in-db  344  (41%)   never became an atom                       -> +17.3  THE LEVER
  rank-miss  111  (13%)   ...only 19 VERIFIED                        -> +0.96
```

FEAT-487 (ζ + cross-encoder + multi-hop decomposition) is marked **`declined`**. A
1-hour diagnostic killed 12-18h of work worth one point. **Do not resurrect it.**

**(b) The competitor numbers are not on our axis.**

| system | claimed | retrieval budget | answerer / metric |
|---|---|---|---|
| mem0 | **92.5** | **top-200** (~6,956 tok/call) | LLM judge, "varies" |
| Letta | **74.0** | filesystem grep, **no extraction at all** | **GPT-4o-mini** |
| **us** | **46.10** | **top-10** | **pinned cheap answerer, token-F1** |

**mem0 retrieves 200 memories per question. We retrieve 10.** That is a different
task, not a better system — and our own `rank-ok` bucket (46%) proves it from the
other side. **We are not 46 points behind mem0.**

**Do not close the gap by weakening the benchmark.** If you ever publish a top-200
or LLM-judge number, publish the k=10 token-F1 number beside it.

**(c) Four of six competitors ship their FLAGSHIP mechanism dead or mis-wired.**

- **mem0's ADD/UPDATE/DELETE** — the thing their whole marketing rests on — **zero
  callers**. Their real path only ever emits `ADD`.
- **mem0's temporal grounding** — elaborate "anchor to Observation Date" prompt;
  **both call sites never pass the `timestamp=` kwarg**, so it defaults to
  `datetime.now()`. **"Last week" anchors to TODAY, on every call.**
- **cognee's cascade multi-round extraction** — eval-harness only, never fires for a
  real user. And broken anyway: prompt passes `previous_nodes`, template reads
  `{{ previous_entities }}` — Jinja renders the mismatch as **empty string,
  silently**. Each "iterative" round is **blind**.
- **graphiti's overlap-aware chunker** — 826 lines, unit-tested, **ingest path never
  calls it**.

**We are not behind on ideas. Nobody's ideas are running.** Which means: **verify
invocation on everything you build, including your own.**

---

## SLICE-1 — Search the raw transcripts we already store (HIGHEST VALUE)

**We already store every raw transcript in full. We have never once searched it.**

```sql
-- migrations/001-init.sql:22
CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,      -- THE FULL RAW TRANSCRIPT
  ingested_at INTEGER NOT NULL
);
```

- `memories_fts` is the **only** FTS index.
- `src/search/` **never touches `transcripts`**. The only readers are two
  `SELECT id FROM transcripts` idempotency checks in `ingest.ts`.

**This reframes the diagnosis.** We said *"344 facts never reached the store."*
**They did.** They are in `transcripts.content` right now. They just never became
**atoms**, and atoms are the only thing we search.

**Letta's best LoCoMo number (74.0) came from exactly this, taken to the extreme —
no extraction step at all.** Their `conversation_search`
(`message_manager.py:1140-1260`, **INVOKED**) does hybrid vector+FTS search over
every raw message ever stored, independent of extracted memory.

**Why this is the best lever:** it is the only one that **does not depend on the
model getting smarter.** The data is already on disk.

### Build it as a SUPPLEMENT, not a replacement

Atoms still give us dedup, contradiction detection, structure, provenance. This is a
**fallback path for what extraction drops.**

### Real risks — measure, do not assume

1. **`transcripts.content` is the WHOLE transcript, unchunked.** Raw FTS over it
   returns an entire session as one hit — useless. **Needs turn-level or
   chunk-level indexing.** This is the bulk of the work.
2. **REDACTION.** Stage-0 ingest redacts, so this *should* be safe — but a second
   index over raw text is exactly the kind of thing that quietly re-exposes a
   credential. **Verify it, do not assume it.** Non-negotiable before this ships.
3. **It may just move the loss into `rank-ok`.** A raw conversational turn is
   noisier than a clean atom. Retrieving the right turn does not mean the *cheap
   fixed answerer* can use it. **The fact may migrate from `not-in-db` to `rank-ok`
   and score exactly the same.** This is the central uncertainty — measure it early
   with a small slice before building the full path.
4. **Pool dilution perturbs ranking.** `fuse.ts` uses **min-max normalisation over
   the candidate pool**, so a hit's score depends on what else is in the pool with
   it. Adding a second source of candidates **changes existing ranks**. Watch the
   ADR-005 floors (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7).

**Estimated gain: +4 to +10. Highest ceiling, highest variance. Cost: days.**

---

## SLICE-2 — Mechanical exhaustiveness rules in the extraction prompt (CHEAPEST)

**mem0 and cognee independently converged on the same trick:** convert *"be
exhaustive"* from an abstract instruction into a **mechanical, checkable rule** the
model cannot quietly skip.

- **mem0** (`prompts.py:907-915`, **INVOKED on the real path**): an *"Exhaustive
  Extraction Checklist"* with an **expected-count heuristic** — *"10+ messages →
  expect 5-15 memories; fewer than 3 → re-read"* — and the **"first-topic-dominance"
  anti-pattern named explicitly and forbidden.**
- **cognee** (`generate_event_graph_prompt.txt`): *"ANY action or verb represents an
  event... **every single verb** corresponds to an event that must be extracted...
  Quantity over filtering — better to extract too many than to miss any."*

**"First-topic-dominance" is a named, plausible cause of a real chunk of our 344.**
Our extraction prompt (`src/distill/prompts/extract.ts`) has **no such guard, no
expected-count heuristic, and no re-read trigger.**

**Also worth lifting from mem0's prompt** (all on their invoked path):
- *"Contextually rich, not atomic"* with paired bad/good examples (*"User has a dog"*
  vs *"User has a dog named Poppy and morning walks are the highlight of their day"*)
- A **transition-capture rule**: on any state change, record **old state AND new state**
- **Proper-noun / qualifier preservation** with worked examples

### The risk you must measure

**More atoms is not automatically better.** Over-extraction produces junk atoms that
**dilute the candidate pool** — and because `fuse.ts` normalises over that pool,
junk **actively perturbs ranking**, it doesn't merely waste space.

**Measure precision AND recall.** Gate on the ADR-005 floors and the LoCoMo
per-category table. A recall win that tanks precision is not a win.

**Estimated gain: +3 to +6. Cost: hours. Do this FIRST — it's nearly free.**

---

## SLICE-3 — Ensemble extraction (2+ models / prompts, union the atoms)

Real, and the evidence is *accidental*: **cognee's "multi-round" extraction was
secretly just independent sampling** (their rounds are blind, per the Jinja bug). So
any recall gain they measured came **purely from sampling variance** — which is
evidence that ensembling works.

And our own numbers scream model variance: **codex 2488 atoms vs qwen3:8b 136
atoms** on identical input.

### The failure mode that would make this BACKFIRE

**Our dedup is a content hash** (`finalHash` over normalized text). Two models phrase
the same fact differently:

- *"Melanie painted a sunset last year"*
- *"Melanie made a painting of a sunset in 2022"*

**Different hash. Both survive.** Do that across 3 extractors and the pool fills with
paraphrases — **and pool dilution perturbs ranking** (see above).

**So: ensemble WITHOUT semantic near-duplicate collapse is not neutral. It can make
things worse.** Build embedding-based dedup FIRST, or don't build this.

### Measure it for free before building anything

The A/B run (codex vs qwen3.5:4b extraction, same 3 conversations, same commit) gives
you **two atom sets over identical input**. Compute the **overlap vs complement**:

- If the two extractors find **the same facts** → ensembling buys nothing. **Kill it.**
- If they find **different facts** → union recovers real ground.

Better still: take the **344 `not-in-db` questions** and check whether the *other*
extractor found the fact the first one missed. **That directly measures the ceiling
of ensembling on our actual failure set**, at zero LLM cost.

**Do that analysis BEFORE writing any ensemble code.**

**Estimated gain: +4 to +8, at 2-3x extraction cost. Needs semantic dedup first.**

---

## SLICE-4 — Finish the date grounding (small, real)

**Measured on the eval store: date grounding IS running and mostly working.**

```
atoms                          : 601
with an ABSOLUTE date in text  :  72  (12%)
still holding a RELATIVE date  :  11  (2%)

GROUNDED  : "Melanie ran a charity race ... on 2023-05-20"
UNGROUNDED: "Melanie painted a sunset over a lake LAST YEAR"   <- gold answer is "2022"
```

**~13% of temporal atoms still leak a relative date.** The atom says *"last year"*,
the gold says *"2022"*, token-F1 scores **zero** — on a fact we stored correctly and
retrieved successfully.

**Cheap fix worth taking (from graphiti, `edge_operations.py:576-620`, INVOKED):**
when the main extraction returns a **null/relative** date, fire a **second, cheap,
single-purpose small-model call** for *just that field*. Not a redesign — a **second
chance at the specific thing that's missing.**

**Estimated gain: +1 to +2. Cost: hours.**

---

## DO NOT DO THESE

- **Do not "fix temporal" by grounding dates harder.** Graphiti explained why it
  can't work: their query-side temporal is **just a filter that nothing
  auto-populates from natural language** (`search_filters.py:149-209` — no NL-date
  parser exists in the repo). **The retriever never reads the dates it stores.** Our
  LoCoMo harness never sets `as_of` (deliberately — see `answer.mts`'s header). We
  and graphiti are in the identical position. **#189/#191 worked and the score still
  didn't move.** Temporal's loss is downstream (answerer can't do date arithmetic;
  token-F1 punishes phrasing). It is `rank-ok` wearing a temporal hat.
- **Do not build reranking / ζ / cross-encoder.** Ceiling is ~1 point. Measured.
- **Do not copy mem0's ADD/UPDATE/DELETE architecture.** It is dead code — marketing
  fiction, not running software.
- **Do not copy cognee's temporal.** It is **worse** than ours: `year` required,
  `month`/`day`/... silently default to 1/1/0/0/0, so *"in 2019"* is stored as
  `2019-01-01T00:00:00` — **a fabricated precise timestamp with no unknown-marker.**
- **Do not touch `scripts/eval/locomo/answer.mts`'s prompt, model, or k.** It is the
  deliberately-fixed cheap answerer. Changing it inflates the score while telling you
  nothing about whether memory improved. (Concurrency was fine and is merged — #253.)
- **Do not run two model-loading things at once on the 8 GB GPU.** I did this three
  times tonight and corrupted a run each time. `qwen3:8b` (5896 MB) + embedder does
  not leave room for anything else. **Note: spawning ANY daemon now triggers the
  scheduled doctor canaries (#226), one of which is an LLM chat probe that pulls
  `qwen3:8b` into VRAM.** That alone will wreck a concurrent eval.

## Priority order

1. **SLICE-2** (exhaustiveness prompt) — hours, nearly free, +3 to +6
2. **SLICE-1** (raw transcript search) — days, +4 to +10, no model dependency
3. **SLICE-3** (ensemble) — only after the free overlap analysis says it's worth it
4. **SLICE-4** (date-grounding retry) — hours, +1 to +2

**Realistic total: +8 to +15 → lands us around 0.55-0.60.** Not +20. And **not 92.5**
— that number was bought with a 20x retrieval budget and an LLM judge.

## Environment

- **Prod daemon is deliberately STOPPED** and its scheduled tasks (`AstraMemoryD`,
  `AstraMemoryDWatchdog`) **DISABLED**, to keep the GPU quiet. Restore with
  `schtasks /change /tn AstraMemoryD /enable` (+ watchdog) then
  `node dist/cli/index.js service start`. Captures spool to disk — no data loss.
- Released today: **v0.17.0** and **v0.17.1** (both on npm; 0.17.1 restores
  `reinstall --rollback`, which 0.17.0 broke).
- **Work in your own worktree.** Migration numbers: take from
  `git ls-tree origin/main migrations/ | tail -1` **immediately before pushing** —
  never from a message, never from a green CI check on a stale base. Nine collisions
  in one day; one bricked prod.
- Ollama: `OLLAMA_KEEP_ALIVE=-1`, models never self-evict. Unload explicitly:
  `curl -X POST localhost:11434/api/generate -d '{"model":"qwen3:8b","keep_alive":0}'`

## The meta-lesson, because it will save you a week

**The ranking plan I wrote was reasonable, well-argued, and wrong.** What saved it was
making the diagnostic a **gate** with an explicit **kill condition**, and honouring it
when it fired. A 1-hour measurement killed 12-18h of work worth one point.

**And every competitor we read has our disease.** Four of six ship their flagship
mechanism dead or mis-wired. **The differentiator in this space is not having the
idea — it is checking that the idea actually runs.**

**Measure before you build. Especially when the plan feels obviously right.**
