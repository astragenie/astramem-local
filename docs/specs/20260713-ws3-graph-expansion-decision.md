# WS3 — 1-hop graph expansion into recall: decision (2026-07-13)

**Verdict: KILL** (do not build now; see reopening bar at the end — a future
rerun of LoCoMo alone will not clear it).

Scope: read-only design review of whether astramem-local should add
automatic 1-hop expansion over `entity_relations` into `search`/`recall`,
per the LoCoMo multi-hop workstream (WS3) in
`docs/specs/20260713-locomo-score-plan.md`. No source touched.

---

## AC-5 first, because it determines how to read everything below

**Yes — this is substantially a rubber stamp, and that is the correct
outcome, not a failure of the exercise.** The independent architect review
(`docs/specs/20260713-locomo-architect-review.md` §3) already did the hard
part: it caught that the plan mischaracterized a deliberate deferral as an
accidental gap, cited `FEAT-481-design.md` §4.3 by name, and concluded
*"not 'finish unbuilt v1 work' — 'make the case that FEAT-481's own
re-opening bar is now met'... this should be last in sequence, and gated on
items 1-2 actually landing and being re-measured first."* The architect
design doc (`20260713-locomo-architect-design.md`, WS3 section) independently
reached the same place: *"EVIDENCE-TOO-THIN, reframed."*

My job here was narrower than either of those docs: **does the n=32 LoCoMo
multi-hop evidence, specifically, clear the bar FEAT-481 itself set?** That
question hadn't been answered head-on yet — both prior docs correctly
identified the right question but stopped at "not yet, gate on more data."
I went one step further and concluded the answer is **no, and not because
the sample is small** (though it also is) **but because LoCoMo evidence is
the wrong kind of evidence for the bar as written.** That's a harder verdict
than "wait for more data," and it's the one new thing this review adds. See
the category-error argument below.

---

## AC-3 — mechanical claim, independently verified

Confirmed independently, not just trusted from the reviewer's grep:

```
grep -r "entity_relations|entityRelations|EntityRelationRepo" src/search/
→ zero hits
```

Broadening to the whole repo, `entity_relations`/`EntityRelationRepo`
appears in exactly 10 files — all either the write side
(`distill/stages/05-extract.ts`, `distill/stages/08-embed-index.ts`,
`distill/pipeline.ts`, `distill/prompts/extract.ts`), the storage repo
itself (`storage/entity-relations.ts`), plumbing/logging
(`storage/relation-guard-log.ts`, `storage/memory-events.ts`,
`server/lib/wire-meta.ts`), the doctor canary (`doctor/checks.ts`), or the
standalone MCP tools (`mcp/server.ts` — `get_entity_related` /
`get_entity_timeline`, called explicitly by a client, not from inside
recall). None of the ten is under `src/search/`.

I also checked what `search.ts` *does* do with entities, to be precise about
the distinction the architect docs draw: `search.ts:22,452-456` imports
`EntityRepo` (not `EntityRelationRepo`) and uses
`memoryIdsForEntities`/`memoryIdsForEntitiesAsOf` for the `entity` filter
path and the ζ entity-bonus (`entityBonusForQuery`, `:325`, only invoked
when `zeta > 0`). That's a direct entity→memory lookup against
`memory_entities`, a flat one-hop-simpler table — not a traversal over
`entity_relations` edges. So: recall today does zero graph expansion. The
mechanical claim is correct and I reproduce it independently.

---

## AC-2 — engaging with FEAT-481 §4.3 directly

`docs/specs/FEAT-481-design.md:504-511`, verbatim:

> *"Neither cloud nor this design adds automatic 1-hop graph expansion into
> search/recall results — cloud hasn't built it either, so there's no
> demand signal to copy, and this repo has a consistent taste for keeping
> retrieval's default blast radius small and opt-in (FEAT-453 §10 Q4). Ship
> `get_entity_related` as an explicit, separate tool call in v1; revisit
> expansion as a v1.1 follow-up only with real usage evidence."*

Two things in this passage matter more than the plan credited:

1. **The rationale is not purely "no evidence yet."** It's evidence *plus* a
   stated architectural taste — "a consistent taste for keeping retrieval's
   default blast radius small and opt-in." That taste is a design
   preference, not an absence-of-data placeholder. Overriding it requires
   evidence that specifically justifies widening the blast radius for real
   users, not just any evidence that a number could go up somewhere.
2. **The reopening condition is "real usage evidence,"** not "revisit when
   an eval shows headroom." Those are different bars, and the difference is
   the whole question this review has to answer.

The plan's own "dilution risk" caveat for WS3 — *"expansion adds candidates,
which can dilute precision and hurt single-hop"* — is, word for word, the
same risk FEAT-481's authors already priced into the decision to keep
expansion out of v1 (small, opt-in blast radius = protecting exactly the
majority-case precision that unconstrained expansion would put at risk).
The plan re-derived this and presented it as new analysis. It isn't new; it's
the original design working as intended.

---

## Does LoCoMo clear the bar? The category-error argument

This is the actual decision, and it's not just "n=32 is thin" (though it
is). It's that **benchmark performance and usage evidence are different
kinds of evidence, and FEAT-481's bar asked for the latter.**

"Real usage evidence" in context means: real users, or real production
traffic, demonstrating that the lack of graph expansion is costing them
something — e.g., people manually chaining `get_entity_related` calls
because recall alone isn't connecting facts they need connected, or support
signal that says "the system knows both facts but doesn't put them
together." That's evidence about **demand** from the actual deployed
system.

LoCoMo's multi-hop category is neither of those things. It's 32 synthetic
QA pairs, from one academic benchmark conversation, scored by a
deliberately fixed, cheap answerer whose own docstring says the harness
"measures the memory system, not the LLM's world knowledge"
(`scripts/eval/locomo/answer.mts`, cited in the plan's own integrity
constraint). Improving that category's score answers "would a specific
graph-traversal feature help on this specific synthetic benchmark," which
is a real and legitimate question — but it is not the question FEAT-481
asked before reopening its own decision. Scoring two benchmark points higher
tells you nothing about whether any actual astramem-local user, in real
usage, has ever been underserved by the absence of expansion. It is
entirely possible to gain LoCoMo multi-hop points and simultaneously ship
something with zero real-world value, or negative real-world value if the
dilution risk lands on single-hop queries (which are a much larger and more
representative share of real usage than a benchmark's curated multi-hop
subset).

This means the natural next step the wave plan already schedules — rerun
LoCoMo at full sample so n=32 becomes something like n≈220-450 — **does not
change this answer.** A bigger number from the same kind of evidence is
still the wrong kind of evidence. It would make the *benchmark* case more
statistically sound; it would not manufacture the *usage* case FEAT-481
asked for. Conflating "the benchmark number got more reliable" with "users
now clearly need this" is exactly the category error to avoid.

Setting the category-error question aside for a moment and grading the
benchmark evidence on its own terms anyway, it still doesn't clear a
reasonable bar:

- n=32, one conversation, 7.0% sample (not the plan's stated 10% — per the
  independent architect review's correction). Per-category n this low is
  exactly what the plan's own global caveat says not to trust for sizing.
- Estimated headroom is **+2 pts** — nominally not even the smallest of the
  five workstreams (WS4 open-domain is +1.8), but WS4 is *also* explicitly
  held back for the same "too thin to fund" reason, so WS3 and WS4 are tied
  for the two weakest evidence bases in the entire plan, not a lone outlier.
- The downside is asymmetric: single-hop (70 questions, 35.2% of the whole
  benchmark, current answered-F1 0.57 / current F1 44.4 — both already
  higher than multi-hop's 0.44 / 35.4) is more than double multi-hop's mass
  and is already performing better. A dilution effect that shaves even 1-2
  points off single-hop while gaining 2 on multi-hop is a wash at best and
  net-negative at worst, and nothing in the current evidence rules that out.

---

## AC-4 — if this were ever revisited, how dilution would actually be measured

Not funding it now, but for the record (and so a future reopening isn't
argued on vibes either): the architect design's proposed gate is the right
shape and should be preserved if this is ever reconsidered —

- Gate behind a config flag, default off, mirroring the ζ/η governance
  pattern (`config.ts:103-104`, `applyFusionGovernance`) already used for
  entity-bonus and agent-bonus.
- Evaluate against the existing ADR-005 harness
  (`tests/eval/retrieval-eval.test.ts`, recall@10 ≥ 0.9 / NDCG@10 ≥ 0.7
  regression floors) **on both single-hop and multi-hop metrics jointly**,
  not multi-hop alone — a design that only reports the metric it's trying to
  improve can't detect the dilution risk it's supposed to be checking for.
  Flip the default only if single-hop's floor holds *and* multi-hop
  improves; a result where multi-hop gains and single-hop merely "holds
  within the floor" is not evidence of no dilution, only evidence the floor
  wasn't tripped — expect this design to also report the raw single-hop
  effect size, not just pass/fail against the floor, if the case is ever
  remade.
- Sequence after WS2's single-hop fix lands (not just its diagnosis), so
  the single-hop baseline being protected is already in its best-achievable
  state — testing expansion against an unfixed single-hop baseline would
  misattribute WS3's net effect either direction.

None of this is a build recommendation. It's what "properly gated" would
have to look like if real usage evidence — not a bigger LoCoMo rerun —
ever justified reopening FEAT-481 §4.3.

---

## What would actually reopen this

Per FEAT-481's own bar, restated precisely rather than left vague:
production telemetry or direct user signal showing real astramem-local
usage is bottlenecked by the lack of expansion — e.g., logged patterns of
clients calling `get_entity_related` immediately after a `recall` that
missed the connected fact, or explicit user-reported gaps of the "it knew
both things but didn't connect them" shape. A full-sample LoCoMo rerun is
worth doing anyway (it's already scheduled in Wave 2 for WS2/WS4's benefit),
and if multi-hop headroom holds up at full sample it's a mildly useful data
point — but on its own it is not sufficient to reopen this decision, for the
reason above, and should not be cited as such when Wave 2's results land.

---

## Summary

- **Verdict: KILL.** Do not build 1-hop graph expansion now.
- FEAT-481 §4.3 was a deliberate, reasoned deferral, not an oversight; the
  plan's mischaracterization of it (already caught by the architect review)
  should not recur in any future framing of this work.
- The dilution-risk argument in the plan is FEAT-481's own rationale
  re-derived, not new evidence — it should not be cited as a fresh reason to
  reconsider.
- The mechanical claim is independently confirmed: `src/search/*.ts` performs
  zero queries against `entity_relations`.
- n=32 is thin, but the deeper problem is categorical: LoCoMo benchmark
  performance is not the "real usage evidence" FEAT-481's reopening bar
  asked for, and a full-sample rerun would not change that — it would only
  make the same wrong-shaped evidence more precise.
- This is substantially a rubber stamp of a decision that was already
  correct, refined by directly answering the one question the prior two
  documents correctly identified but left open.
