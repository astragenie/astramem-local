# Is the atom the right primitive? — structural review (lens 3/3)

*2026-07-14 · Architect review, requested by team lead · read-only, no code, no commits*

Scope: the lead's question is narrower than "is the atom a good design" (the
2026-07-13 teardown already answered that — Charge 1, REFUTED). The question
here is whether **atom-only retrieval** — the decision that the *only*
searchable surface is the LLM-extracted, lossy summary of a conversation,
never the conversation itself — was ever examined, or just inherited.

## 1. Direct answer

**Atom-only retrieval is design debt nobody re-examined. It is not the same
claim the teardown already refuted, and the teardown's refutation does not
cover it.**

The teardown's Charge 1 ("the atom is the wrong unit") tested Gate 1:
*can the atom's schema express the facts a competitor's ontology expresses?*
It found yes — the bitemporal columns are correct, `as_of` filtering is
correct, the gap is an unpopulated field, not a structural ceiling. That is
a claim about **row expressiveness**. It says nothing about **read-surface
completeness** — whether the set of things a query can ever match against
is complete. Those are two different architectural decisions that happen to
have been bundled into one artifact (the atom) at write time:

1. *What's the unit of write-time structuring?* → atom. Correct, per the
   teardown, and I found nothing in this pass that changes that.
2. *What's searchable at read time?* → currently, only the same unit
   produced by decision 1. **This is the debt.** Nothing about atoms being
   the right structuring primitive requires that the raw material behind
   them be unsearchable. It is unsearchable today because `src/search/`
   (verified directly, zero hits) never queries `transcripts`, not because
   of any argued design reason. The two `SELECT id` idempotency checks in
   `ingest.ts` are the only readers of that table in the whole codebase.

The teardown never asked question 2. It couldn't have — its protocol Gate 1
is scoped to schema expressiveness, and none of the six investigators'
briefs touched retrieval-surface completeness. This is a real gap, not a
relitigation.

## 2. What atoms actually buy — load-bearing vs. ceremony, named by code path

The lead asked for this to be specific, not elegant:

| Property | Load-bearing today? | Evidence |
|---|---|---|
| **Contextual compression** | **Yes — the strongest argument for atoms existing at all.** A raw turn ("yeah, same as before") is frequently not self-contained; coreference and cross-turn synthesis happen at extraction. This is the one property a raw-turn index structurally cannot replace. | `src/distill/stages/04-compact.ts`, `05-extract.ts` |
| **Dedup / near-duplicate merge** | Yes, live. | `consolidate.ts:557-587` (cosine ≥ 0.92 auto-merge; runs regardless of contradiction-detection state) |
| **Contradiction detection** | Yes, live, on by default. Judge operates over atom-level propositions — you cannot run a semantic contradiction check on an un-normalized turn without first extracting a claim from it, which is what extraction *is*. | `contradiction-judge.ts`, `defaultConfig()` `mode: 'enabled'` |
| **Provenance** | Yes — atoms carry session/transcript linkage used for citation. | `src/storage/memories.ts` |
| **Bitemporal validity** | **Designed to be load-bearing, not currently exercised.** Columns exist and are correct (teardown finding #5); `AtomSchema` has no `valid_at`/`invalid_at`, `InsertInput` has no `valid_to`. Zero atoms currently populate this. Worth being honest that this row in the table is aspirational, not proof of the primitive's value today. | `src/distill/prompts/extract.ts:73-96`; `src/storage/memories.ts:6-74` |

Four of five are real and load-bearing. None of them are an argument
*against* also having a narrower, lower-trust fallback search surface over
the pre-compression material — they're an argument that the atom should
stay the *primary* retrieval unit, which is a different claim than *only*.

## 3. Is "extract then search the extract" defensible given ~50% invariant loss?

Not as the sole surface. The extraction-loss number is no longer a
hypothesis — WS2 (`docs/research/20260713-single-hop-root-cause.md`)
directly measured it: **36–47% of attempted single-hop LoCoMo questions
have no matching atom anywhere in the store, across two independently
extracted runs (different models, same transcripts)**, and spot-checked
4 of 5 sampled "missing" facts **verbatim, word-for-word, in
`transcripts.content`** (the fifth was an inconclusive substring search, not
a negative). WS1 (temporal) and WS4 (open-domain) hit the same wall by a
different route. This is not a ranking problem — WS2's own conclusion is
that `fuse.ts`/`rerank.ts` tuning "cannot recover points... where there is
no matching atom in the candidate pool to rank in the first place."

So: the system pays storage cost today for a corpus (`transcripts`) that
already contains a meaningful fraction of the facts extraction discards,
and returns zero retrieval value for that cost. That is close to the
canonical shape of this repo's dominant disease — **built, stored, never
invoked** — just one layer removed from the usual "built, wired, never
called" version, since this is capacity that was never wired to search at
all, in either direction.

## 4. Redaction — checked, not assumed

The lead's constraint was explicit: any proposal touching raw text must
state how redaction is *verified*, not assumed. I traced both insert paths
in `src/server/routes/ingest.ts`:

- Canonical path (`:319-322`): `redactIfEnabled` runs on every turn, the
  **redacted** turns (`redactedTurns`) are what gets JSON-stringified into
  `transcripts.content` (`:373`).
- Legacy path (`:813,822`): same — `redactedContent` is computed by
  `redactIfEnabled` before the `INSERT INTO transcripts`.

**`transcripts.content` is not raw. It is stage-0-redacted, identically to
what `memories`/`memories_fts` already receives.** A search index built by
indexing this column inherits the existing redaction guarantee for free —
it is not a new redaction surface, it is a second index over material that
already cleared the same gate. This is a materially different risk profile
from the teardown's finding #4 (LLM-proxy `.quarantine/` spool, which *is*
genuinely pre-redaction plaintext on disk with no TTL) — do not conflate
the two. Any implementation must index `transcripts.content` specifically,
not the proxy spool, and should say so explicitly in its own design doc so
a future reader doesn't assume "raw transcript index" means the unredacted
proxy path.

## 5. The failure mode the lead flagged — moving loss from `not-in-db` to `rank-ok`

This is the real open question, and I did not wave it away. A raw turn is
not a fact; noise in the pool costs something even if it doesn't cost a
correct answer outright; and a cheap answerer may not be able to use an
unstructured excerpt the way it uses a structured atom. Two design choices
mitigate this without resolving it by assertion:

1. **Fallback tier, not fused pool.** Query the transcript index only when
   the atom pool is empty or weak (below a confidence threshold), never
   union it into the same ranked list atoms compete in. This sidesteps
   `fuse.ts`'s min-max pool-dilution hazard entirely — `normalizeScores`
   (`fuse.ts:87`, applied at `:174-181`) renormalizes over the whole
   candidate pool, so adding a second source changes every existing atom's
   rank even when the second source contributes nothing useful. A
   gated fallback that only fires on a weak/empty atom pool is provably
   inert on every query where atoms already answer it — the ADR-005 floors
   (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7) are measured on exactly that
   population and are untouched by construction, not by re-verification
   after the fact.
2. **Distinct trust tagging.** Raw-turn hits should carry different
   provenance than atom hits (e.g. "unverified excerpt" vs. structured
   memory) so a downstream answerer — or the eval harness — can weight
   them differently rather than treating a raw dialogue line as equivalent
   evidence to a compacted, deduplicated, contradiction-checked atom.

Whether this actually helps net score, or just relocates the miss from
"absent" to "present but the answerer can't use it," is an empirical
question, not a design one. Section 6 is the cheap way to answer it before
committing to any of this.

## 6. Cheapest experiment — measurable offline, today, no build

WS2 already did most of this and stopped one step short. It confirmed
*existence* (does the gold fact appear anywhere in `transcripts.content`)
but explicitly did not measure *rank* (would a keyword search actually
surface the right turn in a top-k window) — its own "what I could not
determine" section names this as the single most consequential open
question.

**Proposed experiment, reusing WS2's exact method (read-only
`better-sqlite3` against the existing eval datadirs, no daemon, no live
Ollama, no embedding calls):**

1. Take the WS2 single-hop "missing" set (26 questions, run 1; 18,
   run 2 — both already enumerated with `qa_id`s in that report).
2. For each, build a throwaway in-memory SQLite FTS5 (or even a plain
   keyword/BM25-lite scorer) over the `transcripts` rows for that
   question's session, scoped to the same conversation the gold fact
   came from.
3. Query it with the gold question text (or a stemmed/keyword-extracted
   form of it — LoCoMo questions are frequently paraphrased relative to
   the dialogue, which is the real risk this test exists to surface).
4. Check whether the turn containing the verbatim fact lands in the
   top-10 (matching the production vecK window WS2 flagged as the thing
   it couldn't test).

This is bounded, cheap (under an hour of scripting against data already on
disk), and directly answers the "existence vs. rank-findable" question
without writing any production code. **If keyword search does not surface
the fact-bearing turn for a meaningful share of the missing set — because
LoCoMo's paraphrase gap defeats naive lexical match — that is the answer,
and it's a cheap way to find out before anyone builds an index.**

Coordination note: WS7 (chunk-size sweep, in flight per this session's task
list) is independently deciding chunk boundaries for the *extraction* path.
Whatever unit WS7 settles on for chunking is a reasonable candidate unit
for a fallback index too — avoid inventing two separate chunking schemes
for the same underlying transcripts.

## 7. Kill condition

Kill the raw-turn-fallback proposal if **either**:

- The offline experiment in §6 shows keyword/FTS search over
  `transcripts.content` fails to surface the gold-bearing turn in a
  top-10 window for most of the WS2 missing set (i.e., existence in the
  transcript does not translate to lexical findability — the paraphrase
  gap dominates). This would mean the fallback mostly succeeds at turning
  `not-in-db` into `rank-miss`, which is strictly worse than doing
  nothing: same wrong answer, plus a new index to maintain.
- A prototype fallback tier, run through the ADR-005 CI eval, drops
  recall@10 or NDCG@10 on the existing atom-only population *at all* —
  that would mean the "gated, inert-when-atoms-answer" design assumption
  in §5 was wrong in practice, not just in theory, and the isolation
  didn't hold.

## 8. Integrity line

**Does this make the memory better independent of the benchmark?** Yes, if
built as scoped: real users lose facts to the same extraction ceiling WS1/
WS2/WS4 all hit, independent of LoCoMo. The fallback only fires when the
atom pool is weak/empty, so by construction it can only add recall on
facts the system has already lost — it cannot be tuned toward gold-token
phrasing because it isn't competing for rank against atoms in normal
operation. It also converts genuinely dead storage cost (`transcripts` is
written unconditionally today, on the *current wire contract*, and read by
nothing but idempotency checks) into a safety net, which is a "close the
gap this repo already diagnosed as its own disease" move, not a
benchmark-chasing one.

**The version of this that WOULD cross the line:** tuning the fallback's
ranking function specifically to LoCoMo's phrasing, or promoting it from
fallback to co-equal ranked source because it moves the score. Any
implementation should be able to point at "only fires when atom pool is
weak" as the thing that keeps it honest, and that gate should not be
loosened just to chase a benchmark delta.

**Verification in production, not just in a test — required, not
optional, given this repo's documented pattern.** If this is ever built,
the fallback's fire-rate must be wired into `doctor` as a new canary
(rate of "answer came from transcript fallback, not atom pool" over time)
in the *same slice* that ships it, not as a follow-up. This repo has
shipped the identical shape of gap four separate times already — hardcoded
`{ok:true}` (#2), doctor never running unattended (#3), a probe testing
the wrong request shape (#7), zero-yield extraction being indistinguishable
from an empty transcript (#5b) — and every one of those was "the mechanism
exists, nobody wired the alarm." A fallback-tier fire-rate canary is
actually a natural byproduct: a rising fallback-fire-rate over time *is*
early warning that extraction quality is degrading, which is the exact
signal `checkMemoryHealth` currently cannot produce (teardown finding #2).
That's a second reason to build it, independent of the LoCoMo delta.

## 9. What the 2026-07-13 teardown missed

**One real thing: it never asked whether atom-only was the right read
surface, because its protocol scoped Gate 1 to schema expressiveness
("can the row hold the fact"), not to corpus completeness ("is the row the
only thing a query can ever match"). Charge 1's REFUTED verdict is correct
and stands — the schema is not wrong — but it does not cover the question
asked of this review, and nothing in the teardown's six investigator briefs
touched `transcripts` as a retrieval surface (confirmed: `src/search/` has
zero references to that table, and no teardown finding mentions it by
name).**

Everything else the teardown covered in this territory — bitemporal
correctness, the atom-as-write-time-unit decision, mem0's write-path being
dead code, the H2-vs-H1 gate math — I found no reason to revisit. This is
a narrow addendum to a verdict I am not asking anyone to overturn: **atoms
stay the primary primitive; the debt is that they were never examined as
the *exclusive* one, and the fix on the table is additive (a gated
fallback), not a rewrite of the write path, the schema, or the daemon.**
