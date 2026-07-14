# LoCoMo hypothesis ledger — what survived, what died, and what killed it

**Session:** 2026-07-13 night → 2026-07-14 early. **Baseline:** 0.4610 overall F1 (n=1986,
full suite), category-averaged 0.4007.

**Why this document exists.** Twelve confident hypotheses were advanced this session. **Nine
were falsified.** Every single correction came from an agent *re-deriving* the claim against
raw data rather than inheriting it from a handoff. The failure mode is not "we were wrong" —
it is that **wrongness propagated through documents** until someone opened the underlying
file.

Read the REJECTED table before proposing anything. If your idea is in it, the burden is on you
to explain what new evidence you have — not to re-argue the theory.

---

## 0. The meta-finding — read this first

**Every measurement instrument we built this session was substantially wrong, and they all
break the same way: they are built on token containment, which is precisely the defect they
were built to measure.**

| Instrument | Error |
|---|---|
| `diagnose-retrieval.mts` | **42% false-negative rate** (n=50, stratified). Buckets a captured fact as "never extracted" because `"folks"` doesn't stem-match `"individuals"`. Tracked in **#267**. |
| misattribution detector v1 | ~85% false-positive rate |
| misattribution detector v2 | missed 3 of 4 known-true cases |
| chunk-size sweep (n=1) | effect **smaller than the run-to-run variance** |
| six-model comparison | 5 of 6 models run at `--runs 1` on 15 fixtures; 1 run at `--runs 3` on 43. **Unmatched protocol.** Tracked in **#281**. |

**The error points the wrong way.** A false negative in the retrieval diagnostic is a fact we
*stored, retrieved, and still scored wrong on* — it belongs in the **unfixable** bucket, not
the fixable one. Every false negative **shrinks the prize and grows the ceiling**.

**RULE: before trusting a diagnostic, measure the diagnostic.** An hour spent validating an
instrument killed 12–18h of work worth ~1 point.

---

## 1. SURVIVED — merged, with the evidence that justified them

| PR | Finding | Status |
|---|---|---|
| **#262** | The extraction prompt **told the model to write ISO-8601 dates into atom `text`**. The scorer's normalizer strips punctuation, so `2023-05-07` → the single token `20230507` → **scores exactly 0.0, even when the date is correct.** **115/321 temporal answers were bare ISO; 93% scored zero.** | merged, **UNMEASURED** |
| **#269** | The conversational extraction prompt **told the model to discard interpersonal reactions** as "sentiment padding" — and LoCoMo scores exactly those as gold facts. | merged, **UNMEASURED** |
| **#266** | `withTimeout` **abandoned but never cancelled** LLM calls — a caller giving up at 300–800ms left the Ollama generation running 9–30s more, holding the GPU's single execution slot invisibly. Plus: `format: json` guarantees valid JSON, **not a JSON array** — the decomposer got an object, `Array.isArray` rejected it, and it **returned `[]` on 48 of 48 real queries.** | merged |
| **#277** | Date-grounding **retry** — a second, narrow, regex-*gated* (not regex-*implemented*) LLM call. Rides `ctx.llmExtraction`, invoked at `pipeline.ts:296`, capped at `maxCalls: 50`/job. | merged, **UNMEASURED** |
| **#254 / #255 / #256** | Three canaries that could never fail: a memory that exists and can never be recalled had no canary (13 live in prod); the auto-capture canary counted *all time* (green forever once history accrues); the no-`ok:true`-in-`catch` build guard **was scanning a file that had become a shim.** | merged |
| **#272** | #253 shipped LoCoMo answering concurrency with **no rate-limit handling**. A 429 killed the run. | merged |

**Note the shape of #262 and #269.** Both are cases where **we instructed the model to throw
the data away, and then measured it for missing it.** #283 (compaction) is a third. **This is
the dominant defect class of the session, and it is a PROMPT class, not a model class.**

---

## 2. REJECTED — the hypothesis, and the data that killed it

### 2.1 "Chunk size is the lever" — **DEAD**
Called "the finding of the night." A CONFIRMED comment was posted on #273 and a builder was
dispatched. Then the raw sweep data was opened for the first time:

```
conv-26/s10 | 3200 chars | SAME session, SAME config:  0 atoms / 3 atoms / 7 atoms
conv-48/s20 | 3200->6  2400->4  1600->2  1200->0    INVERTED
conv-43/s2  | 3200->6  2400->0  1600->1  1200->1    chaotic
conv-30/s13 | 3200->2  2400->6  1600->0  1200->3    non-monotonic
conv-44/s18 | 0/0/0/2/0 — never recovers its facts at ANY size
```

**The effect is smaller than the variance.** The bench README *mandates* `--runs 3` (extraction
stdev ~7.1 F1, ~14-point peak-to-peak, FEAT-450). The claim was made at **n=1, zero repeats.**
**Retracted publicly on #273.**

> **PR #283 re-made this exact claim from n=2** ("483-char → 6 atoms, 2029-char → 9 atoms; the
> model extracts ~3x more densely"). It is contradicted by the 30 data points above. **Two
> people independently fell into the same trap four hours apart.**

Data: `scripts/eval/extraction-bench/results/chunksize-sessions-full/report.md`

### 2.2 "Reranking / FEAT-487 is worth +7 to +11" — **DEAD, worth ~+1**
```
rank-ok    386  (46%)   retrieved in top-10, STILL answered wrong
not-in-db  344  (41%)   "never extracted"  -> 42% of these are FALSE NEGATIVES
rank-miss  111  (13%)   only 19 VERIFIED   -> ranking is worth ~+1
```
FEAT-487 budgeted 12–18h. **A one-hour gate killed it.** Marked `declined`.

Independently: **the decomposer never worked at all** (0/48, #266). Had the flag been flipped
and re-run, we would have measured "decomposition doesn't help" and been **wrong about why.**

### 2.3 "Raw-transcript search is +4 to +10" — **DEAD**
344 gold facts are present in `transcripts.content` and never searched. Looked like free points.
**Turn-as-answer F1 = 0.137.** The facts are **findable but unanswerable** — a raw turn is not
an answer. Recorded as a KILL in **#278**.

### 2.4 "The `rank-ok` ceiling is +19.4" — **WRONG, it is +7.86**
Those 386 questions **already average F1 0.596**. The +19.4 assumed they scored zero. The
slices were fine; the arithmetic was stale. Corrected in **#274**.

### 2.5 "The extraction gap is +17.3" — **WRONG**
The diagnostic that produced it has a **42% false-negative rate** (§0). Honest split:
```
42%  false negatives   -> not ours
58%  genuinely absent
      22%  known mechanism (reactions #269, granular specifics)
      36%  NO MECHANISM  <- the largest genuine gap, still unexplained
```

### 2.6 "The bench judge is conservative, like #267" — **WRONG, and I was wrong to suspect it**
It is a genuinely semantic LLM judge (*"paraphrasing, reordering, or different wording is
fine"*), ~14% FN rate, self-agreement stdev **0.0**. **Suspicion was unfounded.** (A real but
separate bug exists: `matched_gold_index` off-by-one, 4/417 verdicts — **#280**.)

### 2.7 "A batch-truncation bug in `08-embed-index.ts` is eating atoms" — **DEAD**
Refuted by a contiguity check: atoms span sessions head-to-tail, no suffix cutoff.

### 2.8 "Poisoned distill jobs explain the missing facts" — **DEAD**
The jobs table is clean: **272/272 `completed`.** Missing facts scatter across normal
atom-yield percentiles. **The benchmark run was infrastructurally clean, so 0.4610 is NOT an
understatement.**

### 2.9 "`TURN_BOUNDARY_RE` is the recency root cause" — **DEAD (caught before dispatch)**
`packTurns` **rejoins** turns. For a session under the cap, chunk text is byte-identical
whether the regex matched 24 turns or zero.

### 2.10 "A named-speaker regex fixes misattribution" — **PROVEN NO-OP for LoCoMo**
LoCoMo's `buildIngestEnvelope` **already** wraps turns as `user: Joanna: I found an awesome
hiking trail…`. **The model can already see who spoke, and misattributes anyway.** #282 remains
open because it has real value for the *legacy v0.0 / raw* ingest path — **but it cannot move
the benchmark.**

### 2.11 "Ensemble / multi-pass extraction is dead" — **PREMATURE; data leans KEEP**
31–46% complementary recovery observed between models. **Not killed — untested.** Now moot
under the codex-only decision, but do not cite this as a rejection.

### 2.12 "qwen3:8b is broken" — **CONFOUNDED, not established**
It was measured as **both extractor and compactor simultaneously.** Never isolated.
**And a second confound surfaced later:** `ollama.ts` hardcoded `CHAT_TIMEOUT_MS = 60_000`,
while the bench records qwen3:8b at **154.5s/session**. **Its "20 failed fixtures" may be the
clock, not the model.** See §4.

### 2.13 "Swap SQLite for a faster store" — **REJECTED, and already adjudicated**
Recall latency is **~135ms embedder + single-digit-ms SQLite scan.** Distill is **seconds of
LLM**. The store is **1–3% of every path that matters.** `sqlite-vec` *is* brute-force KNN with
no ANN index — but that only bites at **~100k+ vectors**, and no store is near that.
The 6-agent teardown already returned **H2 — salvage, not rewrite; zero of five redesign gates
cleared.** **The embedder call is the latency, not the database.**

---

## 3. THE FINDING OF THE SESSION — and it came from running the system, not theorizing

**Stage 4 (compaction) ran a CODING-AGENT compressor over personal conversations,
unconditionally, with no size gate.** (Issue **#284**, PR **#283**.)

```
COMPACT_SYSTEM: "You are a transcript compressor for AI coding agent sessions."
  PRESERVE: file paths, commands, error messages, stderr, TODO items
  REMOVE:   thinking-out-loud, false starts, generic acknowledgments
```

**Nothing in PRESERVE covers a personal fact, event, relationship, preference, or feeling.**
The REMOVE list describes most of what a personal conversation *is*.

**EXTRACTION has two profiles** (engineering + conversational). **COMPACTION has one.**
`extractProfile` **never reached `04-compact.ts`** — the pipeline resolved it *after* the
compact call. It could not arrive, even in principle.

Measured on five real turns, compaction deleted **before extraction ever ran**: a named person
(Alice), a relationship (the sister), a place (Portland), a life event (the move), a dated plan
(summer camp in June) — **and every speaker name.** The extraction prompt *requires* every fact
be attributed to a named person. **Compaction had already deleted the names, so extraction
could only drop the atom or guess. It guessed wrong.**

**Nothing errored.** Fewer atoms is not a failure. The compactor "succeeded" on every call.
**ADR-015 exactly: success and silent failure were the same observable state.**

**It was found by turning compaction OFF and watching the atom count triple** — not by any of
the twelve theories above.

> **CAUTION, and it is not rhetorical: 3× atoms is NOT automatically 3× better.** `fuse.ts`
> min-max normalises over the candidate pool, so **junk atoms do not merely waste a slot — they
> RE-RANK the good ones.** A recall win that costs precision is a **regression**. The score, not
> the atom count, is the verdict.

---

## 4. STILL OPEN — unmeasured, not rejected

| # | Item | Note |
|---|---|---|
| — | **Compaction OFF** | **The headline. Unmeasured.** Run in flight. |
| — | **Temporal: 0.1318 across 321q** | **Biggest single prize: ~+4.9 points.** #262 and #277 both target it and **neither has ever been scored.** Two prior temporal fixes (#189/#191) failed — **but both were fighting a compressor upstream of them.** With compaction off, the "extraction gap" theory gets its **first clean test.** |
| **#275** | Exhaustiveness checklist | **HELD.** Its rationale — closing a 3.5× atom deficit (codex 7.7/session vs qwen 2.2) — **was measured on a model we no longer use.** Its "quantity over timidity" language could inflate junk on a strong model. **Must be a single-variable A/B on codex.** |
| — | **First-topic vs last-topic dominance** | **We have written down BOTH.** #275's rule forbids **first**-topic fixation; the conv-44/s18 observation found only the **LAST** topic surviving. **Contradictory, both n≈1, neither replicated.** Settle this before shipping a prompt rule that aims the model at the wrong end of the transcript. |
| **#280** | Judge `matched_gold_index` off-by-one | 4/417 verdicts; `judge.ts` never validates `< goldAtoms.length` |
| **#281** | Six-model comparison | Needs a matched-protocol rerun (43 fixtures, `--runs ≥3`) |
| **#267** | The retrieval diagnostic's 42% FN rate | **Everything downstream depends on this instrument.** |
| — | `atom.evidence` may be empty in production | Neither live extraction run populated it. Unfiled. |

### The `CHAT_TIMEOUT_MS` question — unresolved and consequential

`ollama.ts` hardcoded **`CHAT_TIMEOUT_MS = 60_000`**. Every local LLM call — compaction *and*
extraction — was capped at 60s on a GPU that spills layers to CPU. **This may have been
silently selecting for models that are FAST ENOUGH TO FINISH, and we called it quality.**

**#276 changed the shipped default model on the strength of numbers measured under that wall.**
Moot for the score (codex-only now) — **but not moot for the shipped product.**

---

## 5. Rules earned the hard way

1. **Measure before you build. Then verify the instrument isn't measuring itself.** Both halves
   were needed this session; the second half is the one everyone skips.
2. **`--runs 3` or it didn't happen.** Extraction stdev is ~7.1 F1. **Two n=1 chunk-size claims
   were made and killed four hours apart by two different people.**
3. **A recall win is not a win until precision holds.** `fuse.ts` normalises over the pool.
4. **Re-derive, don't inherit.** Every correction this session came from opening the raw file.
   **Handoffs propagate errors at full confidence.**
5. **When the model underperforms, read the prompt before blaming the model.** Three separate
   times (#262, #269, #284) **we had instructed it to do the wrong thing.**
6. **Prefer the experiment to the theory.** Twelve theories, nine dead. The one finding that
   mattered came from **turning something off and looking at the number.**
