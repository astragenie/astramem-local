# Independent architect review — LoCoMo score-improvement plan (2026-07-13)

Reviewing `docs/specs/20260713-locomo-score-plan.md` against the actual eval
artifacts, actual source, and actual design docs — not the plan's prose.
Every claim below was independently re-derived from primary evidence: the raw
`hypotheses.jsonl` / `run-manifest.json` / `sample.json` for the two runs that
underlie the plan's numbers, the memory rows in the qwen3:8b run's own
`memory.sqlite`, and the extraction/search/FEAT-481 source. I did not
coordinate with the other reviewer.

**Bottom line: the plan's empirical numbers are honest and independently
reproducible byte-for-byte. Its causal story for item 1 (temporal) is
correct and, if anything, under-sold — I found the exact code location of
the gap. Its causal story for item 3 (graph expansion) is wrong: it
describes a deliberate, reasoned architectural deferral as an accidental
oversight. Item 2 is missing a nearly-free existing lever. FEAT-485's "zero
impact" claim is true today and will become false the moment FEAT-485 ships
its own stated scope.**

---

## 0. The measurement itself — is any of this trustworthy?

I re-ran the judge math from the raw files rather than trusting the plan's
table.

- `docs/eval/20260713-locomo-10pct-two-config.md` reveals the plan's
  "baseline" is actually **one of two sibling runs** from a same-day A/B
  (codex-subscription gpt-5.4-mini extraction vs local qwen3:8b extraction).
  I confirmed both runs' `run-manifest.json` and
  `hypotheses.jsonl.metrics.json` on disk
  (`.eval-data/locomo/runs/2026-07-13T14-59-21-798Z/` = qwen3:8b, overall
  0.4540; `.eval-data/locomo/runs/2026-07-13T15-49-03-443Z/` = codex
  gpt-5.4-mini, overall 0.4278). **Good news: the plan's per-category table
  (12.4/44.4/35.4/33.7/83.0, overall 45.40) is self-consistent — every one of
  those five numbers matches the qwen3:8b run exactly, not a mix of the two.**
  I initially suspected the two runs' numbers had been cross-contaminated
  when writing the plan; they were not. This is worth stating because it's
  exactly the kind of error I was asked to hunt for, and it isn't there.
- I recomputed abstain/answered counts directly from
  `hypotheses.jsonl` (regex on `"no information available"`/`"not
  mentioned"`) rather than trusting the plan's abstain% column: temporal
  11/37=29.7%≈30% ✓, single-hop 15/70=21.4%≈21% ✓, multi-hop 6/32=18.8%≈19%
  ✓, open-domain 7/13=53.8%≈54% ✓, adversarial 39/47=83.0% ✓. **All five
  exactly reproduce.** The "39 of 152" in item 5 also reproduces exactly
  (6+11+7+15=39, 32+37+13+70=152). This table is not fabricated or
  rounded-to-taste; it's a faithful read of the run.
- One correction: the plan calls this a "10% sample." The run's own prep doc
  (`.claude/artifacts/crew/handoffs/20260713T124313Z-...md` §4) and the
  two-config doc both say 19/272 sessions = **7.0%**, chosen because
  conversation-level is the sampler's only granularity and 7.0% was closer to
  10% than the next option (18.0%). Minor, but "10%" overstates the sample
  precision the plan otherwise correctly worries about elsewhere.

**Verdict on trustworthiness**: the arithmetic is real and I could not break
it. The *statistical power* problem the plan itself flags (n=199, one
conversation, per-category n as low as 13) is real and correctly stated —
open-domain's 0.73 resting on 6 answered questions is exactly as thin as
the plan says. I'd add one thing the plan doesn't: **item 1's evidence does
not depend on this eval's statistical power at all** — the "0/191 memories
contain an absolute date" finding (§2 below) is a direct property inspection
of stored text, not a judge-score statistic, and would hold at any sample
size. That decouples item 1 from the "rerun before funding anything"
caveat that should otherwise gate items 2-4.

---

## 1. Temporal root cause (item 1) — confirmed, and more precisely than the plan states

I independently re-queried the 191 memories in the qwen3:8b run's own
`memory.sqlite` (same run the plan's table is drawn from). Two regex passes,
narrow and broad:

- Narrow (explicit calendar words/relative-day terms only): 28/191 = 14.7%
  contain any date-ish signal.
- Broad (adds "N years/months ago", "a year ago", "recently"): 42/191 =
  22.0%.

The plan's 19.9% sits inside that bracket — plausible, not fabricated,
though I can't reproduce its exact categorization rule. **The load-bearing
part of the claim is fully confirmed and total**: of every date-bearing
memory I found (all 42 in the broad pass), **zero** contain an absolute
resolved date (year number, month name, or weekday) — `absOnly = 0, both =
0` in my script's output. Every single one is an unresolved relative
expression: "yesterday," "last week," "last year," "three years ago," "next
month." Examples verbatim from the actual store: *"Caroline attended an
LGBTQ support group yesterday..."*, *"Melanie shared a painting of a sunset
over a lake, which she painted last year..."* — identical to the plan's own
quotes, confirming it drew from the same data I did.

**I went further than the plan and found the exact code-level answer to its
own open question** ("Does the ingest envelope actually carry a per-session
date through to distill?"):

- **Yes, at the envelope layer.** `scripts/eval/locomo/lib/envelope.ts:48`
  sets `captured_at: parseLocomoDateTime(dateTimeRaw)` — every LoCoMo
  session is ingested with a real, absolute, parsed ISO-8601 timestamp
  derived from LoCoMo's own `session_N_date_time` field
  (`scripts/eval/locomo/lib/dates.ts:21-33`). This is not missing plumbing.
- **No, at the extraction call.** `src/distill/prompts/extract.ts:235-242`
  — the doc comment on the conversational prompt itself, written the same
  day as SLICE-434 — states plainly: *"captured_at is NOT currently
  threaded into this call (05-extract.ts's extractChunk receives no
  timestamp — only PipelineContext.capturedAtMs, plumbed to the embed-index
  stage)... Wiring an actual captured_at into the extraction prompt is a
  natural follow-up once a real anchor value is threaded this deep."* The
  date-grounding instruction in the shipped prompt is stated conditionally
  ("if the transcript states or implies an explicit... date") precisely
  because there is no real anchor value reaching that call today — and
  LoCoMo transcripts never state a date in the turn text itself (dates live
  only in the sibling `session_N_date_time` metadata key), so that
  conditional never fires on this dataset.

**This re-scopes item 1 smaller than the plan frames it.** The plan hedges
"this plumbing... may dominate the cost" as an open question. It doesn't
need to be open: `PipelineContext.capturedAtMs` already exists in memory at
the point `extractChunk` is called (`src/distill/pipeline.ts`); the fix is
threading one already-computed value one call deeper plus a prompt-text
change, not new plumbing from scratch. This is a same-day, well-understood,
already-diagnosed gap — the person who wrote SLICE-434 left themselves a
note about exactly this.

**Where the plan's headroom estimate is optimistic — new finding, not in the
plan.** I pulled the actual 37 temporal gold answers from `sample.json`.
Only 3/37 are genuine "how long ago"/duration questions ("How long ago was
Caroline's 18th birthday?" → "10 years ago"). The other 34 are "When did X
happen" — but **roughly a third of those gold answers are themselves phrased
relative to another absolute date**, not as a bare date: *"The sunday before
25 May 2023"*, *"The week before 9 June 2023"*, *"The Friday before 15 July
2023"*. A memory grounded to a plain ISO date ("2023-05-14") will have weak
token overlap against a gold answer shaped like "the week before 9 June
2023" even once the underlying fact is completely correct — token-F1
penalizes the phrasing mismatch independent of retrieval or grounding
quality (the same effect the methodology doc's "harsher-than-upstream"
caveat already names for sentence-vs-span, but this is a second, distinct
instance of it specific to temporal answers). And the 3 genuine "how long
ago" questions need a **reference date the answerer is never given** —
`buildAnswerPrompt` (`scripts/eval/locomo/answer.mts:38-51`) contains no
"today's date" or `as_of` anchor at all, and its own docstring
(`answer.mts:9-14`) states LoCoMo has no natural per-question anchor the way
LongMemEval's `question_date` provides. Grounding memory text alone cannot
close this specific sub-case; it would need the harness to also hand the
answerer a reference date — a small, legitimate, LongMemEval-precedented
addition, not an answerer-prompt tuning violation (see §5), but a real scope
item this plan doesn't mention.

**Verdict: BUILD.** Root cause is fully confirmed and the fix is smaller and
better-understood than the plan states. Treat "+7 pts" as an optimistic
ceiling, not a committed target, given the phrasing-mismatch and
missing-reference-date issues above. The FEAT-486 trap call-out in the plan
is correct — I confirm `as_of`/retrieval is the wrong diagnosis; re-scope
that ticket.

---

## 2. Single-hop precision (item 2) — diagnosis-first framing is right, but the plan is missing a nearly-free existing lever

I agree diagnosis should precede a fix here — n=70 (35% of all questions) is
too large a lever to guess at. But `src/search/rerank.ts` already ships a
**complete, tested, off-by-default cross-encoder rerank stage** — its own
header states *"ADR-005 ruled local ships v1 with 'no reranker (CPU
budget)' — this stage is the OFF-by-default seam that lets a future rerank
rollout happen via config flip + eval evidence."* It has a deterministic
mock provider (Jaccard overlap, no network) and a real HTTP/TEI-compatible
provider, whole-call fallback on timeout, and its own observability. This is
directly relevant to exactly the diagnosis the plan asks for ("ranked below
k=10, or not retrieved at all — these need opposite remedies"): flipping
`crossEncoder.enabled` and re-scoring is a same-day experiment that
partially *answers* the diagnostic question (if score jumps, precision/rank
was the problem; if not, look at recall/embedding) at a fraction of the cost
of instrumenting `fuse.ts` from scratch. The plan should mention this before
recommending new instrumentation work.

**Verdict: DIAGNOSE-FIRST, as the plan says — but the first, cheapest
experiment already exists in the tree and isn't mentioned.**

---

## 3. Multi-hop / 1-hop graph expansion (item 3) — the plan's history claim is factually wrong

The mechanical claim is correct: I grepped `src/search/*.ts` for
`entity_relations`/`entityRelations` and got zero hits. Recall genuinely does
no graph expansion. Confirmed.

**The causal story is not correct.** The plan states: *"This was explicitly
named as the v1 retrieval surface in FEAT-481's own intake and never
built."* That's true of the **pre-design-review intake text only**
(`.claude/artifacts/loop/backlog/in-progress/FEAT-481.md:44`: *"v1 retrieval
surface = entity_graph MCP tool (neighbors + timeline) + **optional** 1-hop
recall expansion"*). It is **false** of the actual design document that
superseded that intake and is what got built. `docs/specs/FEAT-481-design.md`
§4.3, titled **"1-hop recall expansion: recommend OUT of v1"**
(lines 504-511), states verbatim: *"Neither cloud nor this design adds
automatic 1-hop graph expansion into search/recall results — cloud hasn't
built it either, so there's no demand signal to copy, and this repo has a
consistent taste for keeping retrieval's default blast radius small and
opt-in (FEAT-453 §10 Q4). Ship `get_entity_related` as an explicit, separate
tool call in v1; revisit expansion as a v1.1 follow-up only with real usage
evidence."* The slice breakdown that actually shipped (§5, SLICE-1 through
4) matches this: SLICE-3 is `get_entity_related`/`get_entity_timeline` as
standalone MCP tools, nothing in `search`/`recall`. What exists today is the
design as deliberately scoped, not an abandoned v1 commitment.

This matters for two reasons:

1. **The plan's own "Risk" paragraph for item 3** ("expansion adds
   candidates, which can dilute precision and hurt single-hop") **is
   verbatim the same reasoning FEAT-481's authors already gave** for keeping
   this out of v1. The plan is re-deriving a risk that was already the
   stated rationale for the current architecture, not discovering something
   new — which should raise the bar for building it now, not lower it.
2. **There is a legitimate case to make here, but the plan doesn't make it.**
   FEAT-481 itself set the reopening condition: *"revisit expansion as a
   v1.1 follow-up only with real usage evidence."* The LoCoMo multi-hop
   headroom could plausibly BE that evidence — but that argument needs to be
   made on FEAT-481's own terms (cite the design doc, show why this evidence
   clears the bar it set), not by mischaracterizing the decision as an
   accidental gap in the "built, wired, never invoked" pattern this repo
   otherwise correctly diagnoses everywhere else.

**Verdict: EVIDENCE-TOO-THIN, reframed.** Not "finish unbuilt v1 work" —
"make the case that FEAT-481's own re-opening bar is now met." Given n=32,
the dilution risk against item 2 (already flagged by both this plan and the
original design), and the fact the deferral was deliberate, this should be
last in sequence, and gated on items 1-2 actually landing and being
re-measured first — same ordering the plan already proposes, different
justification.

---

## 4. Open-domain (item 4) — plan's own caveat is correct, nothing to add

Recomputed independently from raw `hypotheses.jsonl`: 7/13 abstained, 6/13
answered = 53.8% ≈ the plan's 54%. Confirmed exactly. The plan already leads
with "n=13, of which only 6 were answered... confirm on a full sample before
spending real effort," which is the right call given how thin this is.
**Verdict: DIAGNOSE-FIRST / hold-for-full-sample, as stated.**

---

## 5. Abstention calibration (item 5) and the benchmark-integrity boundary

Arithmetic reproduces exactly (39/152). I agree this is very likely
downstream of items 1-4 rather than independently fundable, as the plan
says. Nothing to add.

**On the smuggling question** — this is the sharpest question I was asked
and deserves a direct answer: **the proposed fix does not smuggle answerer
improvement.** `buildAnswerPrompt` (`answer.mts:40`) passes only `h.text`;
grounding a relative date to an absolute one and writing it into that same
`text` field is indistinguishable, from the answerer's perspective, from any
other correctly-extracted fact — it's a real memory-quality improvement
(the plan correctly cites this as the standard mem0/Graphiti pattern),
independent of LoCoMo, that happens to also help this benchmark because the
benchmark rewards correct facts. That's the legitimate side of the line.

The one concrete tripwire I'd flag that the plan doesn't name: **do not let
the resolved-date format converge on LoCoMo's own gold-answer phrasing**
("7 May 2023" / "the week before 9 June 2023") for the purpose of maximizing
token overlap. The plan's own worked example already lands on the right
side of this (it grounds to a generic ISO date, "2023-05-14," not LoCoMo's
own "DD Month YYYY" style) — but whoever implements this should be told
explicitly to pick a date representation for real memory-quality reasons
(consistency, sortability, unambiguity) and treat any resulting token-F1
gain as incidental, not to reverse-engineer the format from the gold
answers. I found no other smuggling vector: FEAT-485's `evidence`/
`transcript_ref` fields are confirmed structurally invisible to the answerer
(distinct from `text` — see `AtomSchema`, `src/distill/prompts/extract.ts:73-96`),
so there's no metadata-stuffing risk there.

---

## 6. The two "explicitly NOT a score lever" claims

**FEAT-485 (evidence extraction) — true today, will become false on its own
terms.** Confirmed `evidence` is a field on the atom distinct from `text`
(`src/distill/prompts/extract.ts:81` vs `:84`), and confirmed the answerer
never sees it — so populating it has genuinely zero direct text-overlap
impact, as claimed. **But** FEAT-485's own backlog scope
(`.claude/artifacts/loop/backlog/pending/FEAT-485.md`, scope item 2)
proposes *"consider making evidence non-optional for lesson/decision
atoms"* — i.e., **dropping the entire atom**, not just leaving a metadata
field empty, when evidence is missing. Migration
`migrations/030-evidence-guard-drops.sql` already scaffolds a counter table
for exactly this guard (`evidence_guard_drops`), with a comment naming the
guard function `requireEvidenceForRichTypes`. I confirmed that function does
**not** exist yet in `src/distill/stages/05-extract.ts` (zero grep hits) —
so today, the "zero impact" claim holds, nothing is being dropped. If/when
FEAT-485 ships that specific piece of its own stated scope, it will shrink
the atom pool for `lesson`/`decision` types — and given this exact eval just
demonstrated that atom count is the dominant score driver (0.24 → 0.45
overall F1 tracked ~20x atoms/session, not a retrieval change — see
`.claude/artifacts/crew/runs/20260713T020500Z-locomo-first-scored-run.md`
and the two-config doc), an atom-dropping guard is not a "zero LoCoMo
impact" change. **Recommend the plan qualify this claim**: true of the
current passive state, false of FEAT-485's own proposed scope item 2 —
that piece specifically should be sequenced/re-measured against LoCoMo
before shipping, not waved through as risk-free.

**The 15 Zod poison jobs — unverified, not confirmed false.** I grepped the
full repo (`docs/`, backlog, artifacts) for "Zod poison" and any nearby "15"
count; the phrase appears **nowhere except the plan document itself**. I did
not find a doctor run, queue query, or artifact that produced this number,
and I stopped short of querying the live production daemon's database
directly (out of scope for a read-only architecture review, and the
project's own CLAUDE.md flags that box as multi-tenant/live). This isn't
evidence the claim is wrong — the "prod-quality-only" framing is plausible
and consistent with how poison jobs work elsewhere in this codebase
(`docs/providers.md:401`, `docs/hardening-roadmap.md:21`) — but it's an
uncited number and should get a source (a doctor invocation, a queue
count) before being treated as settled.

---

## Is the ranking correct? What's missing entirely?

**Ranking**: directionally reasonable but the confidence levels behind the
point estimates are uneven in a way the plan doesn't surface. Item 1 has
the strongest evidence of any item — a confirmed, code-located, same-day-
documented gap, independent of eval sample size — but its point estimate is
the most optimistic relative to that evidence (phrasing-mismatch and
missing-reference-date issues above cap it below "+7" in my read). Item 2
has an almost-free first experiment (rerank flip) the plan doesn't mention,
which could resolve its diagnosis in an afternoon rather than requiring new
instrumentation. Item 3 is not "next-most-obvious after 1-2" — it's
reopening a considered decision and should require making that case
explicitly before any code is written, which changes it from a build task
to a design-review task first.

**What the plan is missing entirely**:

1. The existing `src/search/rerank.ts` cross-encoder seam as the cheapest
   diagnostic for item 2.
2. The FEAT-481 design-doc supersession — the plan is reasoning from
   pre-review intake text, not the decision that actually shipped.
3. The temporal gold-answer phrasing distribution (session-relative-to-date
   phrasing for ~1/3 of "when" questions) that constrains item 1's ceiling.
4. The missing answerer-side reference date for genuine "how long ago"
   questions (3/37) — unfixable by extraction-side grounding alone.
5. A citation for "15 Zod poison jobs."
6. A note that FEAT-485's *own* proposed scope (not its current state) is a
   real, not-yet-live LoCoMo risk requiring sequencing, not a blanket
   zero-impact exemption.
7. Whether the real production ingest envelope (plugin/hook-built, not this
   eval harness's synthetic `buildIngestEnvelope`) actually carries a usable
   per-session capture time for arbitrary callers — item 1's fix generalizes
   to real users only if that's also true outside this eval harness, and the
   plan doesn't check.
