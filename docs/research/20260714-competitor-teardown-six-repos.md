# Six competitors, read at source. Nobody's mechanisms are running.

Six parallel read-only investigations (mem0, graphiti, cognee, letta, supermemory,
txtai) against locally-checked-out source, briefed with our own retrieval
diagnosis so they hunted **extraction**, not ranking. Every mechanism was required
to come back with a call-path verdict: **INVOKED / NOT INVOKED / COULD NOT
DETERMINE.**

---

## 1. THE HEADLINE: the competitor LoCoMo numbers are not on our axis

| system | claimed | retrieval budget | answerer / metric |
|---|---|---|---|
| **mem0** | **92.5** | **top-200** (~6,956 tok/call) | LLM judge, "varies", ±1pt self-acknowledged noise |
| **Letta** | **74.0** | filesystem grep, **no extraction at all** | **GPT-4o-mini** |
| Zep/Graphiti | — | — | **no LoCoMo eval exists in the repo** |
| cognee | — | — | **no LoCoMo eval exists in the repo** |
| supermemory | "#1 on LoCoMo" | — | **no protocol published, no code** |
| **us** | **46.10** | **top-10** | **pinned cheap answerer (`gpt-5-mini`, minimal reasoning, 150 tok), token-F1** |

**mem0 retrieves 200 memories per question. We retrieve 10.**

Handing an LLM 200 candidate memories all but guarantees the right fact is in
context *regardless of ranking quality*, and then an LLM grades the answer instead
of token-F1. **That is a different task, not a better system.**

Our own diagnostic proves this from the other side: **46% of our single-hop losses
are `rank-ok`** — the right memory WAS retrieved in the top-10, and the answer
still scored wrong on token-F1. **Give us mem0's budget and answerer and most of
that bucket evaporates.**

**We are not 46 points behind mem0.** We are measuring a materially harder task and
reporting it honestly. Two of the six don't even have a LoCoMo harness in their
repo; one has no source at all.

**Do not "close the gap" by weakening the benchmark.** That is how these numbers get
made. If we ever publish a top-200 / LLM-judge number, publish the k=10 token-F1
number beside it.

---

## 2. EVERY competitor has our disease

Our signature bug is **built-wired-never-invoked**. We found it in **four of the
six repos**, in their flagship mechanisms:

- **mem0's ADD/UPDATE/DELETE** — the decision engine their entire marketing rests
  on — **has zero callers**. `get_update_memory_messages` / `get_fact_retrieval_messages`
  (`mem0/configs/prompts.py:15,176,406`) are dead; `utils.py:15-33` is literally
  docstringed *"Legacy function for backward compatibility."* Their real write path
  **only ever emits `ADD`** and never rewrites or deletes a memory's content.
- **mem0's temporal grounding** — an elaborate prompt section about anchoring
  relative dates to an "Observation Date" (`prompts.py:524-536`) — and **both call
  sites never pass the `timestamp=` kwarg** (`main.py:900-905`, `main.py:2538-2543`).
  `_resolve_dates` then defaults `observation_date = datetime.now()`. So **"last
  week" anchors to TODAY on every real call.** Built, called, **fed no data**. A
  worse variant of our own bug.
- **cognee's cascade multi-round extraction** — their most exhaustive mechanism —
  **only fires inside their own benchmark harness**, never for a real
  `cognee.cognify()` user. And it's broken anyway: the prompt passes context key
  `previous_nodes` while the Jinja template reads `{{ previous_entities }}`
  (`extract_nodes.py:22` vs `extract_graph_nodes_prompt_input.txt:7`). Jinja renders
  the mismatch as **empty string, silently**. So each "iterative" round **never
  receives the previous round's output** — it is not multi-pass, it is independent
  sampling with a multi-pass story attached.
- **graphiti's chunker** — token-aware, overlap-configured, density-gated, fully
  unit-tested (`content_chunking.py`, 826 lines) — and **the real ingest path never
  calls it**. The exact "facts lost at chunk boundaries" mitigation, shipped
  inert.

**We are not behind on ideas. Nobody's ideas are running.**

Corollary worth taking seriously: **if we implement cognee's cascade properly — with
the prior round's output actually fed back in — we would be running it better than
cognee.**

---

## 3. What is actually worth stealing

### (a) Mechanical exhaustiveness rules — cheapest hit on our 344 not-in-db

Both mem0 and cognee independently converged on the same trick: **convert "be
exhaustive" from an abstract instruction into a MECHANICAL, CHECKABLE RULE** the
model cannot quietly skip.

- **mem0** (`prompts.py:907-915`, **INVOKED**): an *"Exhaustive Extraction
  Checklist"* with an **expected-count heuristic** — *"10+ messages → expect 5-15
  memories; fewer than 3 → re-read"* — and the **"first-topic-dominance"
  anti-pattern named explicitly and forbidden**.
- **cognee** (`generate_event_graph_prompt.txt`, invoked only under
  `temporal_cognify=True`): *"ANY action or verb represents an event... **every
  single verb** in the text corresponds to an event that must be extracted...
  Quantity over filtering — better to extract too many than to miss any."*

**"First-topic-dominance" is a named, plausible cause of a chunk of our 344.** Our
extraction prompt has no such guard, no expected-count heuristic, and no
re-read trigger.

**Cost: a prompt change. Nearly free. Attacks the +17.3 bucket directly.**

### (b) Search the raw transcripts we ALREADY STORE — Letta

`conversation_search` (`message_manager.py:1140-1260`, **INVOKED**) does hybrid
(vector + FTS) search over **every raw message ever stored**, independent of
extracted memory. A fact the extractor dropped is still findable in the original
turn text.

**And Letta's best LoCoMo number (74.0) comes from exactly this taken to its
extreme — no extraction step at all.** Their own conclusion is that they scored
best *by abandoning extraction*, not improving it.

**We already have this data.** `migrations/001-init.sql:22`:

```sql
CREATE TABLE transcripts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,      -- THE FULL RAW TRANSCRIPT
  ingested_at INTEGER NOT NULL
);
```

**And we have never searched it.** `memories_fts` is the only FTS index; `src/search/`
never touches `transcripts`; the only readers are two idempotency `SELECT id`
checks in `ingest.ts`.

**This reframes our own diagnosis.** We said *"344 facts never reached the store."*
**They did reach the store.** They are in `transcripts.content` right now. They just
never became **atoms**, and atoms are the only thing we search.

So the +17.3 has two independent paths, and the second does not depend on the model
being smart:

| approach | cost | dependency |
|---|---|---|
| better extraction (checklist, cascade) | prompt + more LLM calls | model quality — never 100% |
| **index what we already store** | one FTS/vec index + a fusion path | **none** |

**Caveats before anyone builds it:**
1. `transcripts.content` is the **whole transcript**, unchunked — raw FTS over it
   returns an entire session as one hit. Needs turn/chunk-level indexing to be useful.
2. **Redaction.** Stage-0 ingest redacts, so this *should* be safe — but a second
   index over raw text is exactly the kind of thing that quietly re-exposes a
   secret. **Verify, do not assume.**
3. It is a **supplement, not a replacement**. Atoms give us dedup, contradiction
   detection, structure. This is a fallback for what extraction drops.
4. **It may just move the loss into `rank-ok`** — retrieving a raw turn does not mean
   the cheap answerer can use it. Measure, don't assume.

### (c) Graphiti — the temporal explanation we needed

**Our date-grounding fix (#189/#191) moved nothing (12.4 → 13.18). Now we know why.**

Graphiti grounds relative dates against a per-episode anchor — **functionally
identical to our `capturedAtMs`**. And their query-side temporal handling is:

> `search_filters.py:149-209` — a plain date-comparison WHERE clause. **Nothing
> auto-populates it from natural-language query text.** No NL-date parser exists
> anywhere in the repo. The burden of "reasoning over time" is pushed entirely onto
> whatever LLM reads the results.

**So the retriever never uses the dates it stores unless something upstream
explicitly asks it to filter — and nothing does.** Our LoCoMo harness never sets
`as_of` (deliberately, per `answer.mts`'s header).

**We and Graphiti are in the identical position: correct bitemporal storage, zero
automatic query-side temporal reasoning.** Grounding dates into atom text was never
going to move the score, because **nothing downstream reads them.**

That is a *mechanism-level* explanation, and it retires the "extraction gap vs
schema gap" argument — it was neither.

Two cheap graphiti/letta temporal borrowings, both **INVOKED** in their repos:
- **A dedicated cheap retry for the missing field** (`edge_operations.py:576-620`):
  when the main extraction returns a null timestamp, fire a *second, small-model,
  single-purpose* call for **just that field**. Not a redesign — a second chance at
  the specific thing that's missing.
- **A temporal-ordering GATE on invalidation** (`edge_operations.py:538-573`): the
  LLM decides *which* facts conflict; a **plain datetime comparison** decides whether
  the invalidation is temporally licensed. **Prevents the judge from invalidating a
  fact backwards in time, by construction.** Worth checking whether our contradiction
  judge has this guard.
- **Letta**: stamp **every turn** with a wall-clock time (not just a session anchor),
  and at read time render each hit's date as **both ISO and a human delta**
  ("2h ago", "3d ago") so the answerer never has to do date arithmetic
  (`system.py:126-147`, `core_tool_executor.py:186-211`).

### (d) txtai — one fusion finding, and it is NOT reranking

Our `fuse.ts` uses **min-max normalisation computed over the candidate pool** — so a
hit's score **depends on what else is in the pool with it**. (Our own retrieval
diagnostic hit this exact trap and had to fix it.)

txtai's **default** hybrid fusion is **RRF** (`hybrid.py:85-105`, **INVOKED** —
`search/base.py:107-119` calls it unconditionally when both indexes exist): fuse by
**rank position** (`1/(rank+1)`), touching no absolute scores at all. **Zero pool
dependency.** Their opt-in alternative uses **median/std** instead of min/max —
still pool-dependent, but far more robust to outliers.

**Fusion strategy is a different lever from reranking.** Our reranking ceiling is
~1 point; a fusion-normalisation change is cheap to test and orthogonal. Worth one
experiment, not a project.

---

## 4. Two dead ends, recorded so nobody repeats them

- **supermemory: no extraction code exists.** 182 MB of dashboard, docs site, SDK
  wrappers and a thin MCP proxy to `api.supermemory.ai`. The repo's own `CLAUDE.md`
  documents an `apps/api` backend that **is not in the checkout** (`IngestContentWorkflow`
  — zero hits repo-wide). Their docs say it plainly: *"Enterprise runs it on
  **Supermemory's proprietary models**."* The "#1 on LoCoMo" README claim has **no
  protocol attached**. Nothing to learn; the only path is black-box probing.
- **cognee's temporal is WORSE than ours.** `temporal_graph/models.py:5-16`: `year`
  is required; `month`/`day`/`hour`/... **silently default to 1/1/0/0/0**. A fact known
  only as *"in 2019"* is stored as `2019-01-01T00:00:00` — **a fabricated precise
  timestamp with no unknown-marker.** They have no capture-time anchor at all. Our
  #189/#191 work is **ahead** of them here.

---

## 5. Recommended next moves, in order

1. **Add the mechanical exhaustiveness checklist to our extraction prompt**
   (expected-count heuristic + "first-topic-dominance" ban + re-read trigger).
   Cheapest possible attack on the +17.3. **A prompt change.**
2. **Index the raw transcripts we already store**, as a *supplement* to atoms.
   No model dependency. The data is already on disk. Validate redaction first.
3. **Stop trying to fix temporal by grounding dates.** Nothing reads them at query
   time. Either build query-side temporal reasoning, or accept the category is
   answerer-bound and say so.
4. **Publish our k=10 / token-F1 caveat loudly** whenever anyone compares us to a
   92.5 or a 74.0. Those numbers were bought with a 20x retrieval budget and a
   frontier answerer.
5. (Cheap, orthogonal) test **RRF fusion** against our pool-dependent min-max.

**And the thing to internalise:** four of six competitors ship their flagship
mechanism **dead or mis-wired**. The differentiator in this space is not having the
idea. It is **checking that the idea actually runs.**
