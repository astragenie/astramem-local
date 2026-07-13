# Independent architecture review — WS1/WS2/WS3 of the LoCoMo score-improvement effort (2026-07-13)

Scope: design coherence, cross-cutting risk, and mutual consistency across WS1
(merged, PR #189 / commit `823e2bd`), WS2 (in-flight, uncommitted working
tree), and WS3 (decision doc, no code). Read-only — no source touched. I did
not coordinate with the parallel correctness reviewer; this is an independent
pass over the primary sources (diffs, live source, working tree), not a review
of the other reviewer's or the plan/architect docs' conclusions.

---

## WS1 — temporal grounding (`captured_at` → extraction) — **NEEDS-CHANGE**

The plumbing itself is correct and I traced it independently rather than
trusting the commit message. `src/distill/pipeline.ts:166` computes
`sessionDateIso = ctx.capturedAtMs != null ? new Date(ctx.capturedAtMs).toISOString().slice(0, 10) : undefined`
and threads it through `extract()` → `extractChunk()` →
`callExtract()` (`src/distill/stages/05-extract.ts:98-165`), which prepends
`"Observation date: ${sessionDateIso}\n\n"` to the user message
(`05-extract.ts:158-160`) only when a value is present — `undefined` produces
a byte-identical user message to pre-fix (verified against the new test at
`tests/distill/05-extract.test.ts` — the `'with no sessionDateIso...'` case
asserts the exact pre-fix string). The prompt-text changes
(`src/distill/prompts/extract.ts:267`, `:581-588`) correctly gate on the
injected line first, falling back to the old conditional wording. This part
is sound and the "additive optional param, low risk" framing in the architect
design doc is accurate **for the plumbing**.

### Finding 1 — the capture→ingest path does NOT re-stamp `captured_at` at ingest time (the suspected bug is not present)

Traced the full path the team lead asked about, end to end:

- `src/cli/capture.ts:152` — `capture claude` builds the envelope via
  `buildClaudeEnvelope(parsed, event, PKG_VERSION, undefined, captureSource)`.
  The 4th arg (`capturedAt`) is omitted, so `claude.ts:140`'s default
  (`capturedAt = new Date().toISOString()`) evaluates **at the moment this
  function is called** — i.e. at CLI invocation, which per the function's own
  doc comment (`capture.ts:55-58`) happens "AT INVOCATION — the hook calls
  this synchronously at agent/session close, while the file is still
  guaranteed live." Same pattern in `src/capture/proxy.ts:691,793` for the
  proxy fork (`buildProxyEnvelope`'s default fires at `session_end`).
- The envelope (captured_at already baked in) is written to the durable spool
  via `writeToSpool` (`src/ingest/spool.ts:31-45`) — a plain JSON file, no
  further mutation.
- `src/ingest/spool-drain.ts:109-110` reads that file back with
  `CanonicalIngestSchema.safeParse(envelope)` and passes the **parsed,
  unmodified envelope** straight to `ingestCanonicalTranscript(db, config,
  parsed.data, file.key)` — there is no re-stamping, no `new Date()` call
  anywhere in the drain path. Retries (`MAX_DRAIN_ATTEMPTS = 5`,
  `recordFailureOrQuarantine`) re-read the same on-disk file on every attempt;
  the `captured_at` field inside it never changes across retries.
- `src/server/routes/ingest.ts:327` (`capturedAtMs = new Date(data.captured_at).getTime()`)
  operates on `data.captured_at` from that same unmodified envelope, whether
  the call arrives via live HTTP or via the spool-drain in-process path.

**Verdict on this specific question: the suspected bug does not exist.** A
transcript that is spooled, retried, or drained hours/days after the daemon
comes back up still carries the genuine capture-time timestamp, not an
ingest-time one. WS1's anchor is exactly as good as the capture-time
timestamp already was before this fix — this fix adds no new staleness risk.

**Minor, lower-severity nuance worth recording (not the asked-about bug):**
`claudeIdempotencyKey`'s doc comment (`claude.ts:171-178`) states that
re-running capture on an **unmodified** transcript is "a same-path overwrite
(refreshed captured_at)" — i.e. if the exact same hook fires twice for
byte-identical content (a retry, not a backfill), the spool file's
`captured_at` is refreshed to the second invocation's wall-clock time, not
the first's. In the ordinary retry case (seconds apart) this is immaterial.
I found no code path in this repo that re-invokes `capture claude` against an
old, previously-spooled transcript long after the fact (no backfill/replay
CLI), so I don't believe this is live today — flagging only because it's a
real, if narrow, gap between "genuine first-capture time" and "most recent
identical-content invocation time" that the current design doesn't
distinguish.

### Finding 2 — over-application risk is real, plausible, and genuinely untested (this is the actual basis for NEEDS-CHANGE)

The prompt instruction is scoped correctly in principle: both the
conversational (`extract.ts:267`) and engineering (`extract.ts:581-588`)
rules condition the model's action on "resolve **every relative date
expression**... against it" — the trigger is a relative expression existing
in the source text, not "always stamp a date." That's the right shape of
instruction and mitigates, but does not eliminate, the risk.

What's actually missing is verification that it holds. I read the 7 new
test cases added in the same commit (`tests/distill/05-extract.test.ts`,
"sessionDateIso temporal grounding" describe block) fully. Every case is one
of:
- anchor present + text contains a relative-date phrase → resolved (5 cases,
  including the `extract()`-level threading case), or
- anchor **absent** + text contains a relative-date phrase → unchanged
  (1 case, the negative test for a missing anchor), or
- the plumbing-only assertion that the injected line appears (1 case).

**None of the 7 cases test anchor-present + text with NO temporal expression
at all** — the exact scenario the team lead flagged. This can't be fully
closed by a mock-LLM unit test (a mock can't demonstrate a real model's
over-application tendency either way — the test suite is explicit that this
is deliberately out of scope, "the actual date arithmetic is the model's
job... not something a unit test with a mock LLM can validate in isolation").
But that only strengthens the point: if a unit test can't validate it, an eval
signal has to, and none currently does. `diagnose-retrieval.mts` (WS2)
computes containment of gold-answer tokens **within** each hit — it has no
mechanism to detect the opposite failure (a hit acquiring extra, spurious
date tokens it shouldn't have). A regression from over-application would only
surface as an unexplained single-hop token-F1 dip in the Wave 2 full-sample
rerun, with no diagnostic pointing at "prompt over-application" as the cause
versus any other explanation.

This matters because of scale: single-hop is 70 questions / 35.2% of the
whole benchmark (current answered-F1 0.57, current F1 44.4 —
`docs/specs/20260713-locomo-score-plan.md` baseline table), more than double
temporal's 37/18.6%. The `Observation date:` line is now unconditionally
prepended to **every** chunk regardless of whether that chunk contains any
date-bearing claim — increasing the surface area for over-application
relative to the pre-fix state (no anchor existed at all, so there was
nothing to over-apply). A wrongly-stamped date in a single-hop atom's `text`
is exactly the kind of noise the plan's own "answerer sees only `h.text`"
constraint (`answer.mts:40`) means can't be filtered out downstream.

**Why NEEDS-CHANGE rather than UNSOUND:** the plumbing is correct, low-risk,
and additive exactly as designed. The gap is procedural, not architectural:
WS1 shipped without an eval-gated check on the one metric (single-hop F1)
that both the plan and the architect design already identified as the
dominant category and the one most exposed to this specific failure mode.
The wave plan (`20260713-locomo-wave-plan.md`, Wave 2) does schedule "full-
sample LoCoMo rerun with WS1," which will incidentally re-measure single-hop
— but that's a post-hoc detection, not a pre-merge gate, and if a regression
shows up there's currently no diagnostic that would attribute it to
over-application specifically versus embedding drift, ranking noise, or
something else. Recommend: before or immediately after the Wave 2 rerun, spot
check a sample of post-WS1 single-hop atoms whose source chunks contain no
date-bearing claim, to confirm the model isn't stamping dates onto them.

---

## WS2 — retrieval diagnostic (`diagnose-retrieval.mts`) — **NEEDS-CHANGE**

The category-agnostic design, the reuse of the real scorer's exact
normalize/stem pipeline (`stemmedTokens` exported from `judge/metrics.mts`
specifically so the diagnostic can't silently drift from what's actually
scored), and the "zero production code changes, reuses an already-uncapped
seam" framing are all verified accurate. `src/server/routes/search.ts`'s
`/recall` route genuinely has no `.max()` on `limit`, unlike `/search`'s
`Math.min(100, ...)` clamp — confirmed by direct comparison, not by trusting
the doc comment.

### Finding 3 — the rank-boundary classification does not measure what it claims to measure (methodology bug, not a nitpick)

This is the load-bearing problem, and it's more concrete than "fuzzy
matching" — it's a mismatch between the candidate pool the diagnostic scores
against and the candidate pool the real answerer ever sees, and it's
independently verifiable in `src/search/search.ts` and `src/search/fuse.ts`.

- The real answerer calls `recall(daemonClient, { text: qa.question, limit: k, ... })`
  with `k` defaulting to 10 (`scripts/eval/locomo/answer.mts:80`,
  `run.mts`'s `--k 10` default) — `limit: k` flows straight into
  `search()`'s `limit` parameter.
- `search()` computes `vecK = opts.vecK ?? Math.max(limit * 4, 50)`
  (`search.ts:387`). For the real answerer: `vecK = max(40, 50) = 50`. This
  bounds **both** the FTS5 candidate query (`search.ts:394-401`, literal
  `LIMIT ?` param `vecK`) and the vector search (`search.ts:428`,
  `vecStore.search(queryVec, vecK)`) — i.e. only the top-50-by-raw-BM25 and
  top-50-by-raw-cosine candidates ever enter the fusion step at all.
- The diagnostic calls `recall(client, { text: qa.question, limit, ... })`
  with `limit` defaulting to 500 (`diagnose-retrieval.mts:168`, `:187`), so
  `vecK = max(2000, 50) = 2000` — given CLAUDE.md's ~10 atoms/session and a
  20-35-session conversation (~200-350 atoms/project), this is large enough
  to pull in essentially the whole project's candidate pool, uncapped.
- Critically, `fuse.ts`'s `normalizeScores()` (`fuse.ts:87-97`) is a
  **min-max normalization over exactly that candidate array** — `search.ts:633,636`
  call it on `filteredFtsHits.map(...)` / `filteredVecHits.map(...)`, the
  arrays that vecK just bounded. Min-max normalization is pool-composition-
  dependent by construction: the same candidate's normalized score (and
  therefore its position in the fused ranking) depends on what else is in the
  pool with it.

The consequence: a `limit=500` diagnostic call does not "return everything
the real k=10 call would return, just more of it" — it runs against a
**materially different candidate pool** (vecK 2000 vs 50) with a
**different, pool-dependent normalization**. Two concrete failure directions
follow:

1. **False `rank-ok`**: the diagnostic finds the answer-bearing atom at, say,
   rank 6 in the vecK=2000 pool and calls it `rank-ok` ("retrieval already
   worked, not a memory-system problem"). But if that same atom isn't even in
   the top-50-by-raw-BM25-or-cosine set that a real vecK=50 call would pull
   in, the real answerer never saw it at all — the diagnostic would clear a
   question as "retrieval fine, answerer's fault" when retrieval genuinely
   failed for the real system's actual parameters.
2. **Miscalibrated `rank-miss`/`not-in-db` split**: even for atoms that
   survive both pool sizes, a different min/max shifts every candidate's
   normalized bm25/cosine component, which can reorder the fused top-10
   independent of any real ranking-quality difference — so "rank-miss" (found
   at rank 11-500) doesn't necessarily mean "would rank 11+ under the real
   vecK=50 pool" and could go either direction.

This directly undercuts the intended use of the split: the plan's own
"opposite remedies" framing (rerank/fusion tuning for rank-miss vs. distill-
side extraction fix for not-in-db) assumes the classification reflects what
the production k=10 path actually does. Since it's measured under a
structurally different pool, a "dominant bucket" conclusion drawn from this
tool risks recommending the wrong fix for single-hop — the largest category
in the whole benchmark (35.2%). This is worth fixing before the diagnosis
result is used to choose a fix direction: either call `recall` at the real
`k`/`vecK` (accepting that a true "how far down would this rank" measurement
needs a debug/`vecK`-matched mode, e.g. reusing `opts.debug`'s existing
`normBm25`/`normCosine` breakdown machinery already in `search.ts:556-615`
rather than a plain large `limit`), or explicitly caveat every non-`rank-ok`
verdict as "under a larger candidate pool than production uses" in the
report output, not just the file's own doc comment.

### Finding 4 — the containment matcher's "not-in-db" bucket conflates two causally opposite failures, and the tool's own docstring already half-admits it

`classify()` (`diagnose-retrieval.mts:152-161`) walks hits in rank order and
calls the first one whose stemmed-token containment of the gold answer
clears 0.6 "the atom that answers this question"; if none does, the question
is `not-in-db`. The doc comment (`diagnose-retrieval.mts:27-38`) is candid
that gold `evidence[]` dialog ids are never used for matching — there's no
recoverable mapping from LoCoMo's transcript-turn evidence to our
LLM-paraphrased atoms, so token-overlap-against-the-answer is the only
available proxy. Given that constraint, reusing the real scorer's exact
stemmer (rather than a fresh approximation) is the right call.

But the resulting `not-in-db` bucket conflates two causally distinct
failures the doc comment names but does not separate: (a) the fact was
genuinely never extracted as a distinct atom, and (b) the fact WAS captured,
but phrased so differently from the gold answer that stemmed-token
containment never clears 0.6 (the doc comment: "worth eyeballing a sample" —
i.e. acknowledged, not measured). These need opposite fixes: (a) is a
distill-side extraction-coverage problem; (b) is either a genuine
retrieval-adjacent problem (an existing correct atom just isn't
lexically/semantically close enough to the gold phrasing to be found or
matched) or purely an artifact of this diagnostic's own matching heuristic,
not a system defect at all. Whichever category dominates changes the
recommended fix entirely, and the tool currently reports one number for
both. Given WS1 changes atom phrasing broadly (dates resolved into text, per
above), the paraphrase-mismatch sub-case is not a hypothetical: WS1-affected
atoms are now more likely to diverge lexically from gold answers phrased in
LoCoMo's own date style (the architect review already flagged this exact
tension for scoring, independently of WS2). Recommend at minimum: report a
secondary containment score at a lower threshold (e.g. 0.3) for the
`not-in-db` bucket specifically, so "zero overlap at any rank" (real
extraction miss) can be told apart from "some overlap, but below 0.6" (likely
paraphrase) before spending distill-side effort.

**On whether it can separate `rank-ok` from "answerer failed":** yes, this
part is sound in isolation — a hit clearing the containment threshold within
the real rank boundary is a legitimate proxy for "the fact was retrievable,"
and whether the answerer then used it correctly is a separate, out-of-scope
question per the benchmark-integrity constraint. The caveat is that this
soundness is conditioned on Finding 3 above — "within the real rank
boundary" is only true if the pool the rank was computed against matches the
real pool, which today it does not.

**Why NEEDS-CHANGE rather than UNSOUND:** the tool's overall shape (category-
agnostic, reuses the real stemmer, zero production changes, honest doc-
comment caveats) is a good design, and Finding 4 is explicitly flagged by the
authors as a known limitation rather than hidden. But Finding 3 is not
flagged anywhere in the file and is a genuine measurement-validity bug — the
diagnostic's headline classification does not currently correspond to what
the real k=10 answerer path does, which is the entire point of building it.

---

## WS3 — 1-hop graph expansion: KILL decision — **SOUND**

Independently re-verified the mechanical claim: `grep -r "entity_relations|entityRelations|EntityRelationRepo" src/search/` returns zero hits in the current tree. `src/search/search.ts` imports `EntityRepo` (not `EntityRelationRepo`) and only reaches `memory_entities` via `memoryIdsForEntities`/`memoryIdsForEntitiesAsOf` (`search.ts:452-456`) for the `entity` filter and the ζ bonus — a flat, one-hop-simpler table, not a graph traversal over `entity_relations`. Recall does zero graph expansion today; confirmed independently, not trusted from either prior doc.

### Question 1 — does the category-error argument prove too much?

This is the sharpest question and deserves a direct answer rather than a
diplomatic one: **no, it does not prove too much, but the document never
states the boundary that keeps it from proving too much, which is a real
writing gap even though the underlying reasoning survives scrutiny.**

The argument as written is: FEAT-481 §4.3 (`docs/specs/FEAT-481-design.md:504-511`,
verified above) set an explicit, named reopening bar — "real usage evidence"
— for **this specific, previously-and-deliberately-deferred feature**. A
LoCoMo score cannot clear a bar defined as production usage evidence, at any
sample size, because it is categorically the wrong kind of evidence for that
specific bar.

If this were instead argued as "benchmark evidence is never legitimate
grounds for any architecture decision," it would indeed prove too much and
directly contradict WS1 (built substantially on the "0/191 atoms have an
absolute date" LoCoMo-derived finding) and WS2 (exists purely to interrogate
a LoCoMo category). But that is not the claim being made, and there is a
principled distinction the WS3 doc gets right in substance even though it
doesn't say so explicitly:

- **WS1 and WS2 are not reopening any prior deliberate decision that set an
  evidentiary bar.** There is no ADR or design doc anywhere in this repo
  saying "we chose not to thread `captured_at` into extraction, revisit only
  with production usage evidence" — the pre-fix state was an acknowledged,
  unintentional gap (`extract.ts`'s own prior doc comment, quoted in the
  architect design doc, calls threading `captured_at` "a natural follow-up"
  once plumbing existed — not a considered rejection). Work that completes
  an already-intended, never-finished piece of functionality is ordinary
  engineering, judged on ordinary merits (is the defect real, is the fix
  low-risk, is the benefit worth it) — and the "0/191 atoms" finding is
  legitimate ordinary evidence of a real defect for that judgment, explicitly
  because (per the independent architect review, verified against the
  finding above) it is "a direct property inspection of stored text,"
  independent of eval sample size or benchmark-score interpretation. WS2
  similarly isn't reopening anything — it's read-only instrumentation whose
  output is meant to feed an ordinary engineering decision (rerank tuning or
  a distill-side fix) that will itself be gated on the existing ADR-005
  recall@10/NDCG@10 regression floors, not on a raw LoCoMo score directly.
- **WS3 is different in kind**: it proposes exactly the feature FEAT-481
  already considered and explicitly declined to ship, for named reasons
  (no demand signal, a stated architectural taste for a small/opt-in blast
  radius), with an explicit, quoted reopening condition. Only a decision that
  set such a bar needs evidence of that specific shape to reopen it. WS1/WS2
  were never subject to any such bar, so the argument's scope — "benchmark
  evidence cannot satisfy a bar specifically defined as usage evidence" —
  does not reach them.

**The gap worth fixing**: the WS3 decision doc states "benchmark performance
and usage evidence are different kinds of evidence" as if that were a
free-standing, general principle, without ever explicitly noting that this
principle only bites because FEAT-481 pre-committed to a usage-evidence bar
for this specific feature, and would not apply to a workstream that isn't
reopening a similarly-gated decision. A reader skimming only the WS3 doc (as
opposed to reading it alongside WS1/WS2's own justifications) could
reasonably conclude "LoCoMo evidence never justifies anything here," which
would misstate what actually happened this session. Recommend the WS3 doc
add one sentence making this scope-limitation explicit, so it can't be
mis-cited in a future session as a categorical rule against using eval
evidence at all.

### Other points, independently checked

- The n=32/"7.0% not 10%" correction and the FEAT-481 intake-vs-shipped-design
  distinction were already caught by the prior architect review; I re-derived
  both independently from the same primary sources (`FEAT-481-design.md`
  §4.3, the backlog intake text) and they hold.
- The dilution-risk argument really is the same rationale FEAT-481's authors
  already gave for keeping expansion opt-in — re-deriving it as "new
  analysis" would have been circular, and the WS3 doc correctly declines to
  do that.
- The AC-4 gating proposal (config-flag-off-by-default, joint single-hop +
  multi-hop ADR-005 evaluation, sequenced after WS2's actual fix) is the
  right shape if this is ever revisited, and correctly avoids over-claiming
  it as a build recommendation.

**Verdict: SOUND.**

---

## Cross-cutting: are WS1-3 mutually consistent, and what's the combined risk to Wave 2?

**Mutually consistent, once the implicit scope-limitation in WS3's argument
(above) is made explicit.** As written, a careless reading of WS3 in
isolation could seem to contradict WS1/WS2's own justifications; read
correctly (bar-specific, not evidence-categorical), all three are
consistent: ordinary engineering work (WS1, WS2) is judged on ordinary
engineering evidence including benchmark findings; a previously-declined
feature with an explicit reopening bar (WS3) needs evidence of the specific
shape that bar named, which a benchmark score is not.

**Combined risk to Wave 2's interpretation:**

1. WS1 already shipped without a pre-merge check for over-application onto
   non-temporal single-hop atoms (Finding 2). If Wave 2's full-sample rerun
   shows a single-hop F1 regression, there is currently no tooling in WS2
   (or anywhere else) designed to attribute it to over-application versus
   embedding drift, ranking noise, or the pool-size measurement bug below —
   the regression would need fresh investigation, not a ready-made
   diagnostic.
2. WS2's rank-boundary classification (Finding 3) does not currently measure
   the real k=10 production path — it measures a structurally larger,
   differently-normalized candidate pool. Any "single-hop is dominated by
   rank-miss, turn on the reranker" or "single-hop is dominated by not-in-db,
   fund a distill-side fix" conclusion drawn from Wave 2's diagnosis run
   risks being wrong in a way that isn't visible from the tool's own output
   — it would look like a clean, confident classification either way. Given
   single-hop is the largest category in the benchmark, an incorrect fix
   choice here is the highest-leverage mistake available in the whole plan.
3. Both gaps are fixable before Wave 2's diagnosis run is actually used to
   choose a fix (WS2 hasn't shipped a fix yet, only the instrumentation), so
   neither blocks Wave 1's already-completed work — but both should be
   closed before the Wave 2 diagnosis output is treated as a reliable basis
   for choosing WS2's fix direction.

## Verdict summary

| Workstream | Verdict | Primary reason |
|---|---|---|
| WS1 (temporal grounding) | NEEDS-CHANGE | Plumbing is correct and the ingest-time-restamping bug the team lead suspected does not exist (Finding 1). But over-application onto non-temporal single-hop atoms is untested, plausible, and unmeasured by anything currently built (Finding 2). |
| WS2 (retrieval diagnostic) | NEEDS-CHANGE | Rank-boundary classification is measured against a materially different (larger, differently-normalized) candidate pool than the real k=10 answerer ever sees (Finding 3) — a methodology bug, not a polish item. The not-in-db bucket's extraction-miss/paraphrase-mismatch conflation (Finding 4) is a lesser, already-partially-acknowledged issue. |
| WS3 (graph expansion) | SOUND | Category-error argument holds under scrutiny once its implicit scope limit (bar-specific, not evidence-categorical) is recognized — recommend making that limit explicit in the doc so it isn't mis-cited later as a blanket rule against benchmark evidence. |
