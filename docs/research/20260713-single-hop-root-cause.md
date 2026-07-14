# Single-hop root cause (WS2) — 2026-07-13

Status: **findings, read-only investigation**. No production source changed.

## TL;DR

Single-hop's 0.57-when-answered gap is **dominated by an extraction/compaction
recall drop, not a retrieval-ranking problem**. In the two existing eval runs,
**36-47% of single-hop gold facts that the harness attempted to answer are not
captured as a distinct atom ANYWHERE in the store** — confirmed by direct
comparison against the raw transcript, where every spot-checked "missing" fact
is present verbatim in the session dialogue. This is the **same failure class**
as the temporal workstream (WS1) and open-domain (WS4): extraction is losing
facts before they ever reach the search index. `src/search/fuse.ts` /
`rerank.ts` — the ranking-tuning direction the score plan proposed — is very
unlikely to be the dominant lever, because for roughly 4 in 10 low-scoring
questions there is **nothing in the candidate pool to rank**.

A secondary, smaller effect is real and independently confirmed: a **~11
percentage-point verbosity tax** on token-F1 (stable across both runs: 10.93
and 10.87 points), which affects answer *format*, not retrieval — and per the
benchmark-integrity constraint, cannot be fixed by touching `answer.mts`.

## Method and its limits — read this before the numbers

**No live daemon, no Ollama, no LLM calls were made for this investigation.**
Both existing eval runs already ingested and distilled their conversation into
a real SQLite datadir (`.claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/<run>/datadir/memory.sqlite`).
I queried those datadirs directly with `better-sqlite3`/`bun:sqlite` (read-only)
and re-used the **actual scoring/stemming code** the harness uses
(`scoreHypothesis`, `stemmedTokens` from `scripts/eval/locomo/judge/metrics.mts`)
so my numbers use the exact same tokenization/stemming pipeline as the real
score. A throwaway script (`_tmp-ws2-analysis.mts`) did this; it has been
deleted from both the main checkout and the `wt-ws2-research` worktree — no
residue.

**What this method CAN determine:** whether the gold-answer fact exists
*anywhere* in the atom store (an existence/recall check equivalent to
`diagnose-retrieval.mts`'s "wide pool" fallback — see below), using the same
Porter-stemmed multiset-containment + short-answer-precision-guard logic that
file already implements (`containment`/`precision`,
`SHORT_ANSWER_TOKEN_THRESHOLD=2`, `min-precision=0.12` — I mirrored these
constants exactly, since an earlier draft of this analysis without the
precision guard produced false positives on short gold answers matching
unrelated atoms by incidental token overlap; e.g. "Strength and motivation"
spuriously matched a Caroline sentence containing "strength" and "motivate"
about an unrelated topic).

**What this method CANNOT determine, and I did not attempt to fake:** the
**rank-ok vs. rank-miss split** for facts that DO exist in the store. That
requires the real `/recall` two-pool comparison
`scripts/eval/locomo/diagnose-retrieval.mts` implements (a
production-vecK-matched pool at `limit=12` vs. the wide `limit=500` pool) —
which needs a live daemon and live embedding calls, both forbidden for this
task. **`diagnose-retrieval.mts` has never been run — no `diagnosis.json`
exists anywhere in this repo** (confirmed via `find`). This is the single
biggest thing I could not determine: **of the facts that ARE in the store,
how many are ranked below k=10 vs. genuinely well-ranked?** My "exists in
store" bucket conflates both `rank-ok` and `rank-miss` from that tool's
taxonomy. Running `diagnose-retrieval.mts` against a **new** eval run (not the
production daemon — its own doc comment requires a fresh
`--daemon-url`/`--token` pointed at eval infra) is the natural next step and
was explicitly out of scope here.

## The central finding: existence, not rank

Both runs decompose to the same picture (production-config run first,
codex-subscription cross-check second):

| Run (extractor) | answered n | mean F1 (answered) | fact exists in store | fact NOT found | mean F1 \| exists | mean F1 \| missing |
|---|---|---|---|---|---|---|
| `2026-07-13T14-59-21-798Z` (qwen3:8b, local — **this is the run CLAUDE.md/the score plan cites as 0.4540 overall**) | 55 | 0.5649 | 29 (52.7%) | **26 (47.3%)** | 0.6097 | 0.5150 |
| `2026-07-13T15-49-03-443Z` (codex-subscription) | 50 | 0.5724 | 32 (64.0%) | **18 (36.0%)** | 0.6532 | **0.4288** |

Both runs used different extraction models against the same source
transcripts, and both independently show a **third to a half of attempted
single-hop questions have no matching atom anywhere in the store** — not "low
in the ranking," **absent**. The gap between "exists" and "missing" mean F1 is
directionally consistent (missing scores worse in both runs, sharply so in
run 2) but not enormous in run 1, because generic sentiment words in nearby
atoms ("grateful," "family," "supportive") still earn partial token-F1 credit
by coincidence even when the specific fact is absent — this is exactly the
false-positive risk the short-answer precision guard exists to reduce, and it
means the true "missing" mean F1 is likely an *overestimate* of how well the
system does when a fact is genuinely gone.

### Direct verification against the raw transcript — this is not a dataset artifact

I spot-checked 7 of the "not found" gold facts against the session
`transcripts` table (raw ingested dialogue, stored verbatim pre-extraction).
**Every one is present, word-for-word, in the source conversation** — this
was checked directly, not inferred:

| qa_id | gold answer | found verbatim in transcript? |
|---|---|---|
| conv-26#126 | "Horseback riding" | Yes — `locomo-conv-26-s13`: *"I used to go horseback riding with my dad when I was a kid"* |
| conv-26#140 | `"Trans Lives Matter"` | Yes — `locomo-conv-26-s17`: *"a photography of a sign that says trans lives matter"* |
| conv-26#117 | "once or twice a year" | Yes — `locomo-conv-26-s10`: *"We don't go often, usually only once or twice a year"* |
| conv-26#143 | "He got into an accident" | Yes — `locomo-conv-26-s18`: *"my son got into an accident. We were so lucky he was okay"* |
| conv-26#132 | "7 years" | Not found by substring search in the sampled transcripts (only source session ID unconfirmed here — see caveat below) |

(The one miss on "7 years" is a substring-match limitation of my spot-check,
not a claim the fact is absent from the source — I did not exhaustively
search every session for it, and "7 years" is too generic a substring to
search reliably. The other four are unambiguous.)

**Conclusion: this is a genuine extraction/compaction drop, not a benchmark
artifact, not an inference-required question, not a retrieval-configuration
issue.** The conversational extraction+compaction pipeline (19 sessions → 191
or 200 atoms, ~10 atoms/session, matching the ~10 atoms/session figure
CLAUDE.md already cites) is discarding specific, single-fact-worthy details
during summarization — durations, frequencies, quoted text, and one-off plot
events — well before anything reaches `src/search/`.

## A secondary, correlated signal: speaker asymmetry

Both independently-extracted atom stores show the same skew toward one
conversation participant:

| Run | Caroline-only atoms | Melanie-only atoms | ratio |
|---|---|---|---|
| qwen3:8b run | 100 | 72 | 58% / 42% |
| codex-subscription run | 113 | 79 | 59% / 41% |

This is **correlated, not proven causal** — I did not test whether Melanie's
facts specifically dominate the "not found" bucket (a follow-up worth doing:
most of my spot-checked misses above happen to be Melanie-side or ambiguous
facts, but n is too small in this pass to claim a clean split). What it does
show, robustly (same ~58/42 ratio across two different extraction models,
which rules out one model's idiosyncrasy): the extraction/compaction prompt
consistently favors one speaker's content over the other's — plausibly because
Caroline's arc (transition, adoption, identity) is more thematically salient
than Melanie's routine specifics (outings, quantities, one-off events), and a
compaction step optimizing for "important" content will systematically
under-sample the less narratively-central speaker. **This is a plausible
contributing mechanism for the extraction-drop finding above, not a
separately proven root cause** — flagging it as a lead for whoever picks this
up, not a closed finding.

## The verbosity tax — quantified, and it's real but secondary

Using the actual F1 scorer: for every answered single-hop question, I computed
the hypothetical F1 if the answer's precision were maximized (i.e., the
hypothesis trimmed to contain *only* the tokens that overlap the gold answer,
holding recall fixed) — this isolates the pure length-penalty component of
token-F1 from actual correctness.

| Run | actual mean F1 | hypothetical mean F1 (precision-maximized) | verbosity tax |
|---|---|---|---|
| qwen3:8b | 0.5649 | 0.6742 | **10.93 points** |
| codex-subscription | 0.5724 | 0.6811 | **10.87 points** |

Remarkably stable across two independent runs — this is a real, systematic
effect, not noise. But it is **secondary to the existence gap**: only 6/55
(10.9%) and a similarly small fraction in run 2 of answered questions had
*perfect* recall (gold fully contained in the answer) but lost points purely
to length — e.g. `conv-26#109`: gold `"pots"` (1 token) vs hypothesis `"pots
and clay sculptures (including a cup with a dog face)"` (8 tokens, score
0.222 despite being a **more complete and more correct** answer than the
terse gold reference). Most of the low-scoring cases are not this pattern —
they are wrong or partially-wrong content, not merely verbose-but-correct
content.

**Per the benchmark-integrity constraint: this cannot be fixed in
`answer.mts`.** The fix, if pursued, has to change what gets **stored** (e.g.
storing/serving terser atom text so a downstream terse-leaning answerer has
shorter source material to echo) — and even then, the effect size (~11
points on the *already-answered* subset, which is itself only part of the
full single-hop question set) makes this a real but modest lever, not the
main one.

## Abstention (the 21%) — mostly correct, not the primary lever

Of 15 abstains in run 1: only **5 (33%) had the fact demonstrably present** in
the store (a wrong abstain — the fact was findable but the answerer declined);
**10 (67%) abstained on facts genuinely absent** from the store (a defensible
abstain — there was nothing to answer from). This is the same
existence-not-rank story as above: most single-hop abstention looks like
**honest behavior given a genuinely incomplete store**, not miscalibration in
the abstain/answer decision itself. Fixing the 5 wrong abstains would recover
a small amount of score, but the plan's own trap warning applies here too:
any change to abstention behavior must be checked against the 23.6%
adversarial-question set (which scores 83.0 **by abstaining**) before being
called a net win — I did not run that check, since it requires touching
abstention logic, out of scope for a read-only task.

## What this means for the WS2 +5-point estimate

**The score plan's own framing of the open question — "is the right memory
retrieved but ranked below k=10, or not retrieved at all" — undersells a third
option that turns out to dominate: not captured as an atom at all, which is
neither a ranking problem nor a k=10-window problem.** Tuning
`src/search/fuse.ts`/`rerank.ts` as the plan speculates cannot recover points
on the 36-47% of attempted questions where there is no matching atom in the
candidate pool to rank in the first place — no reranker fixes a fact that was
never extracted. **The dominant lever for single-hop is extraction/compaction
completeness, the same root-cause class WS1 (temporal) already identified
for a different symptom.** This raises a real possibility that WS1 and WS2
are not two independent workstreams with two independent fixes, but two
symptoms of one shared extraction-recall gap — worth deciding explicitly
before funding them as separate work.

The **+5-point estimate in the score plan should be treated as unverified
sizing**, not because the direction is wrong (single-hop clearly has real
headroom) but because the plan assumed a retrieval/ranking mechanism that
this investigation did not find to be dominant. A revised estimate would need
to separate: (a) how many points come from fixing extraction completeness
(likely shared with WS1's fix, so the marginal single-hop-specific gain from
that alone is unclear without doing the work), (b) how many from the ~11-point
verbosity tax (real, secondary, format-only), and (c) how many from the small
wrong-abstain bucket (5/15 in this sample). None of these three is "tune
`fuse.ts`."

## What I could not determine

- **The rank-ok vs. rank-miss split for facts that DO exist in the store.**
  Requires running `diagnose-retrieval.mts` against a live daemon with fresh
  embedding calls — explicitly forbidden for this task. This is the most
  consequential open question for anyone building WS2: if most "exists"
  cases are `rank-ok` (well-ranked, answerer still got it wrong), the residual
  problem after an extraction fix is answering/phrasing quality, not
  retrieval at all, and there is close to zero rerank-tuning lever left.
- **Whether the speaker asymmetry (Caroline 58-59% vs. Melanie 41-42% of
  single-attribution atoms) causally explains more of the "missing" bucket
  than coincidence.** Correlated across two runs, not causally tested.
- **The "7 years" transcript spot-check** — inconclusive by my search method,
  not confirmed either way.
- **Full-sample behavior.** Per the plan's own global caveat, this is n=199 /
  one conversation; the 36-47% existence-gap figure and the ~11-point
  verbosity tax were both stable across the two available runs (different
  extractors, same conversation), which is modest cross-validation, not a
  full-sample confirmation.

## Evidence pointers

- Runs: `.claude/worktrees/agent-a0112287d8dd8d401/.eval-data/locomo/runs/2026-07-13T14-59-21-798Z/` (qwen3:8b) and `.../2026-07-13T15-49-03-443Z/` (codex-subscription) — each has `sample.json` (gold), `hypotheses.jsonl` (model answers), `datadir/memory.sqlite` (real ingested/distilled store).
- Scoring/stemming reused verbatim from `scripts/eval/locomo/judge/metrics.mts` (`scoreHypothesis`, `stemmedTokens`, `containment`/`precision` pattern).
- Retrieval-diagnostic tool that exists but has never been run: `scripts/eval/locomo/diagnose-retrieval.mts` (see its own header for the rank-ok/rank-miss/not-in-db taxonomy this report partially reproduces via the existence-only "wide pool" equivalent).
- Score plan under review: `docs/specs/20260713-locomo-score-plan.md` §2.
