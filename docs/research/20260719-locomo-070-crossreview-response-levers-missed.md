# LoCoMo 0.70 — cross-review response: the levers the plan missed

**Responds to:** `docs/research/20260719-locomo-0.70-research-for-cross-review.md` ("the
doc" below). **Mandate:** find upside the doc missed or under-specified, and creatively
extend the plan — grounded in run data + code, not vibes. Design-ideation only; no source
touched.

## Patterns Found (pre-design)

Tier: **Large** (cross-module retrieval + answerer architecture question, multi-week
campaign, no single FEAT slice). Read: the doc + its 3 cited sources, `src/search/decompose.ts`,
`src/search/search.ts` (WS6 merge block, ~713-1080), `src/storage/entity-relations.ts`,
`scripts/eval/locomo/{answer,judge}.mts` + `judge/metrics.mts`, `scripts/eval/shared/azure-client.ts`,
`src/config/config.ts` (multiHop block + `applyMultiHopGovernance`), the archived run
`docs/eval-runs/20260719-chunkab-800tok/{metrics.json,sandbox-config.yaml}`, and five
astramem-local team decisions/lessons recalled from memory (WS3 entity-relations kill,
WS6 decomposition build, single-hop root-cause history, FEAT-500 answerer-signal prep).

Key prior decisions this design must respect, not re-litigate:
- **WS3 (2026-07-13, `docs/specs/20260713-ws3-graph-expansion-decision.md`): KILL** on
  1-hop graph expansion over `entity_relations` into recall. Reopening bar is *real usage
  evidence*, explicitly **not** "a bigger LoCoMo rerun." Any multi-hop proposal that adds
  `entity_relations` traversal into the retrieval path reopens a categorically-rejected
  decision — flagged below, not recommended.
- **2026-07-13 decision (memory id `6d9b6fae`): the frozen answerer** (`scripts/eval/locomo/answer.mts`)
  is not to be touched — "the PR will be rejected if it touches the answerer." **FEAT-500**
  (same file, `formatSignalBreakdown`/`ANSWERER_SIGNALS`, merged) is the team's own
  sanctioned way around this: an additive, default-off, byte-identical-when-unset flag,
  A/B'd rather than a rewrite. Every answerer-side proposal below follows that precedent
  explicitly, and the doc's Track A ("answerer overhaul... mandatory held-out test split")
  needs this precedent named, or it will read as contradicting a recorded decision.

---

## 0. Steelman, then the crack

The doc's diagnosis is sound as far as it goes: config knobs are genuinely exhausted (three
independent same-day A/Bs agree), temporal really is solved, and the rank-ok ceiling really
is only +7.86 (re-derived twice, `docs/research/20260714-locomo-hypothesis-ledger.md` §2.4).
The §5 bet — single-hop is mostly answerer/format, not retrieval — is honestly labeled
unmeasured, which is the right call.

**But the critical path in §6 has a hole**: *"single-hop diagnostic (§5) → if (b): B → A...
→ C → D → E."* There is no `if (a)` branch. If the diagnostic instead says "retrieval
miss," the doc's own plan has nothing to do next. That branch isn't hypothetical —
it's the **opposite finding** an earlier pass over this exact question reached
(2026-07-14, memory id `ac5a0b29`: *"the single-hop gap in WS3 is an extraction failure,
not a retrieval or reranking failure... the gold fact was missing from the SQLite store for
both eval runs, even though the raw transcript contained it verbatim"*). That finding
predates #262/#269/#277/compaction-off and may be stale — but its existence proves the (a)
branch is a live possibility that needs its own plan, not silence.

---

## 1. Lever 1 (highest confidence, near-zero cost): multi-hop decomposition has never been measured at the current baseline — turn it on before building anything

**This is the biggest miss in the doc.** WS6 query decomposition (`src/search/decompose.ts`)
exists, is fully wired into `search()`'s merge path (`src/search/search.ts:713-851`, the
`opts.decompose` block), and had its one known bug (decomposer returning `[]` on 48/48 real
queries because `format:'json'` guarantees valid JSON but not a JSON *array*) fixed by #266
via an explicit `jsonSchema` constraint (`decompose.ts:139-140`). The doc's own Track C cites
#266 as already landed.

**But `config.multiHop.enabled` defaults to `false`** (`config.ts:1493-1496`:
`multiHop: { enabled: false, provider: 'mock', ... }`), and the archived
`sandbox-config.yaml` for the 0.573/0.584 runs (`docs/eval-runs/20260719-chunkab-800tok/`,
`docs/eval-runs/20260718-control-codex-solo/`) contains **no `multiHop` override at all**.
Every multi-hop number in the doc's §2 table — 0.376, 0.363, the whole "multi-hop weakest,
second lever" narrative — was measured with the sanctioned multi-hop mechanism **completely
inert**, running the exact single-pass code path as if WS6 didn't exist.

The doc's Track C ("ensure decomposed sub-queries surface ALL supporting atoms") talks about
*improving* decomposition. Nobody has yet measured decomposition **at all**, post-#266, on
the current recipe. That is a config-only, code-untouched, same-day experiment:

```yaml
multiHop:
  enabled: true
  provider: llm   # default is 'mock' — a deterministic regex heuristic, not a real decomposer
```

**Why this beats the doc's framing:** it costs a config edit + one conv-1 rerun (~15 min),
zero implementation risk, zero overfit risk (it's a pre-existing, already-reviewed
mechanism), and answers a question the doc doesn't even ask: *is #266's fix worth anything
on real questions, at all, before investing in Track C's "ensure ALL atoms surface"
follow-on work?* If it moves multi-hop even 2-3 points for free, that's pure upside the
plan's arithmetic never counted. If it does nothing or hurts, that's equally valuable —
it means Lever 3 (below) should replace WS6 rather than extend it, and the doc's Track C
should be dropped, not scheduled.

**Rough estimate:** unmeasured by design (that's the point) — but the floor is "no worse
than today" (dilution is bounded by `maxSupplemental`/`supplementalWeight`, `decompose.ts:184-192`,
specifically to prevent this), so the experiment is close to risk-free. Check
`config.multiHop.minQueryWords: 6` (`config.ts:1494`) against real LoCoMo multi-hop question
lengths before running — a 6-word floor could gate out short multi-hop questions and silently
return the same "no decomposition ran" result as `enabled: false`.

---

## 2. Lever 2: reasoning-budget-aware, category-routed answerer — the concrete version of the doc's vaguest track

The doc's Track A says "possibly a stronger model" and "explicit multi-hop reasoning."
Both are true but underspecified — and the codebase already contains the mechanism, unused,
sitting one config value away.

**The mechanism:** `answer.mts` calls Azure `gpt-5-mini` — a genuine reasoning model — with
`reasoningEffort: 'minimal'` **hardcoded** (`answer.mts:204`), and so does the LoCoMo
LLM-judge pass (`judge.mts:102`, `runLlmJudge`). `'minimal'` is documented (verified live,
`scripts/eval/longmemeval/README.md:602-608`) to force `reasoning_tokens: 0` — the model
runs with its reasoning effectively disabled, spending its entire `max_completion_tokens`
budget on the visible answer. This exact family already has an in-repo precedent for this
lever paying off: **FEAT-450 raised the extraction-bench judge's default `reasoning_effort`
from `'minimal'` to `'low'`**, measured, and kept it (`scripts/eval/extraction-bench/README.md:458`).
That upgrade has never been applied to the LoCoMo answerer or judge.

**Why this is the single most impactful lever for multi-hop specifically:** multi-hop
questions ("what does the person who gave Melanie the painting do for work?") require
synthesizing across 2+ retrieved notes — exactly the kind of task effort=minimal is designed
to skip. Single-hop questions ("where did X go on vacation?") need much less synthesis, so
the expected win is smaller there and the risk of regression on temporal/adversarial (already
near ceiling) from touching global effort is real — hence **route by category, don't raise
effort globally.**

**The trap the doc doesn't mention, and why a naive "just raise reasoning_effort" would
actively hurt:** `ANSWER_MAX_COMPLETION_TOKENS = 150` (`answer.mts:36`) is a **shared**
budget — reasoning tokens and visible-answer tokens draw from the same
`max_completion_tokens` pool. Raise `reasoning_effort` without also raising the token budget
and the model can spend its 150 tokens thinking and emit a truncated or empty visible
answer — a silent, category-specific regression that would look exactly like "the model got
worse," not "we misconfigured the budget." Any implementation of this lever must raise
`maxCompletionTokens` in the same change it raises `reasoningEffort`.

**Concrete design (respects the frozen-answerer precedent — mirrors `ANSWERER_SIGNALS`):**

- New opt-in flag, e.g. `ANSWERER_CATEGORY_REASONING=1`, default unset → byte-identical to
  today (same discipline as `answer.mts:315`'s existing `ANSWERER_SIGNALS`).
- When set, `answerConversations`'s worker (`answer.mts:184-206`) selects
  `{ reasoningEffort, maxCompletionTokens }` from `t.qa.category` instead of the single
  hardcoded pair:
  - category 1 (multi-hop, n=32): `reasoningEffort: 'medium'`, `maxCompletionTokens: ~450`.
  - category 4 (single-hop, n=70): `reasoningEffort: 'low'`, `maxCompletionTokens: ~250`
    (smaller bump — less synthesis needed, protects cost/latency on the biggest category).
  - categories 2/3/5 (temporal/open-domain/adversarial): **leave at `'minimal'`/150** —
    they're solved or near-ceiling; the WS3 kill's core lesson (protect the majority-case
    floor, don't let a fix for the weak category dilute the strong ones) applies here too.
- **Free sub-lever, zero code:** `ANSWERER_SIGNALS=1` (`answer.mts:74-83`,
  `formatSignalBreakdown`) has been built and wired since FEAT-500 but — per its own comment
  — "never tested." It costs nothing to flip in the same experiment run: does surfacing
  `[top signal: cosine | cosine=0.59, importance=0.08, ...]` per note change the model's
  confidence/precision on ambiguous single-hop retrievals? Free information either way.

**Rough estimate:** the doc's own arithmetic assumes single-hop 0.49→0.68 (+19pts on n=70,
overall +0.067) and multi-hop 0.36→0.55 (+19pts on n=32, overall +0.031) requires "Track A +
B combined." This lever is a strict subset of Track A, cheaper and lower-risk than a prompt
overhaul (it's a decoding parameter with an in-repo precedent, not new prompt content that
needs a held-out split to trust) — a reasonable expectation is it captures some real
fraction of that headroom on multi-hop specifically, and a smaller fraction on single-hop
(where the mechanism is precision/format per Lever 3, not under-reasoning). Do not treat
this as replacing Track A's held-out-split discipline for any prompt-*content* change layered
on top — only the effort/budget parameters are exempt from that risk, because they carry no
content that could overfit to the eval's specific phrasing.

---

## 3. Lever 3: single-hop's mechanism, sharpened — precision-vs-verbosity is a third axis the doc's (a)/(b) binary collapses

The doc frames single-hop as (a) retrieval-miss vs (b) answerer/format, and bets on (b). The
scorer itself (`scripts/eval/locomo/judge/metrics.mts`, `f1Score`) suggests a third,
**structural, mechanistic** explanation that is neither: `precision = numSame /
predTokens.length`. **Every token in the hypothesis that isn't in the gold answer directly
lowers precision, with no floor.** A correct answer phrased as a sentence instead of a
terse span is punished exactly like a wrong answer, proportional to its length.

This predicts *why* single-hop underperforms temporal (0.68) and adversarial (0.81) despite
sharing the same retrieval stack and the same frozen answerer, without needing to invoke
"format bugs" at all: **temporal's gold answers and adversarial's gold check are both
externally length-constrained** (a date; a fixed abstention substring), which structurally
caps how verbose a correct hypothesis can be before it stops scoring. **Single-hop has no
such constraint** — the same correct fact can be phrased in 2 tokens or 12, and the prompt's
plea for brevity (`answer.mts:94`, "a short phrase, not a sentence") is exactly the kind of
instruction-following that degrades at `reasoning_effort: 'minimal'` on a reasoning model
(see Lever 2).

**This fills the doc's missing third bucket, and it's nearly free to check**: unlike the
§5 retrieval-presence diagnostic (which needs a live store + the known-42%-FN-rate
`diagnose-retrieval.mts` instrument, `docs/research/20260714-locomo-hypothesis-ledger.md`
§0), this diagnostic runs **entirely offline against already-archived `hypotheses.jsonl`
files** with zero LLM calls and zero false-negative risk (it's pure token counting, not
semantic matching): for every single-hop question scored <1.0, compare `len(stemmedTokens(hypothesis))`
against `len(stemmedTokens(goldAnswer))`. A hypothesis:gold length ratio consistently >>1 on
low-scoring single-hop questions, contrasted with a ratio ~1 on temporal/adversarial,
confirms the mechanism directly from data already sitting in `docs/eval-runs/`, before
spending a single token on the (b) diagnostic or Track B's format catalogue.

**Why this beats the doc's plan:** it's a genuinely free, instrument-risk-free measurement
that the doc doesn't propose, it fills the missing `(a)` branch's sibling gap (a mechanism
that is neither "retrieval" nor "the #262 ISO-date class of format bug" Track B is scoped
around), and if confirmed it points straight at Lever 2's per-category reasoning/prompt
budget as the fix — rather than Track B's "catalogue every scorer-zero format" approach,
which is the right instinct for hard-format failures (dates, numbers) but won't fix a
correct-but-verbose sentence, since there's no punctuation/casing normalization that
recovers a precision loss caused by genuinely extra content tokens.

---

## 4. Does fixing retrieval (reviving FTS) raise the ceiling, or just approach it?

**No — and this was measured the same day as the doc, in a workstream the doc doesn't cite.**
`FEAT-480` (`.claude/artifacts/loop/backlog/pending/FEAT-480.md`, deferred 2026-07-19,
same day as this doc) built and A/B'd three FTS-revival variants (pure-OR, AND-first/OR-fallback,
instrumentation-only) against a real 54k-memory store:

```
Baseline (FTS dead):  plain-MRR 0.548, literal-MRR 0.950, junk 10%
FTS revived (v1/v2):  plain-MRR 0.650 (+18.6%), literal-MRR 0.800 (-15.8%), junk 16% (+6pp)
```

The root cause: baseline's strong literal-MRR (0.950) was **already coming from the vector
leg**, not from FTS (which returns zero candidates today — confirmed independently at the
index level, `bm25.raw: null` on every hit). Reviving FTS via OR-semantics doesn't add a
clean second signal on top of the vector leg's existing strength — it **dilutes it**, because
`fuse.ts`'s min-max normalization is pool-composition-dependent (the same mechanism the
retrieval diagnostic's own pool-composition bug fix had to work around, see
`diagnose-retrieval.mts:20-42`). The `coverage>=2` junk-filter gate is a no-op (prunes 2/79
hits); a tighter gate (`>=3`/`>=4`) also cuts legitimate 2-token matches. **Deferred to 0.21
as a genuine plain/literal/junk tradeoff, not a bug with a clean fix.**

**Answer to the mandate's question: fixing FTS approaches a different ceiling (plain-English
recall), while probably *lowering* the literal-keyword ceiling — it is not a rising-tide fix
for the LoCoMo rank-ok gap.** The doc's own retrieval framing (§4: "rank-ok ceiling is only
+7.86... perfect ranking alone can't reach 0.70") already reached the qualitatively right
conclusion for a different reason (ranking, not recall-source count) — this same-day FEAT-480
result is the independent confirmation from the recall-source side that the doc should cite
but doesn't. **Recommendation: do not fund FTS revival as part of the 0.70 campaign.** It's
already correctly deferred; re-litigating it here would waste effort the ledger's own rule 2
("prefer the experiment to the theory") already spent.

---

## 5. What NOT to build: entity_relations graph traversal for multi-hop

The mandate suggests "entity-relation graph traversal" as a candidate multi-hop architecture.
**This was designed, reviewed by three independent passes, and killed on 2026-07-13**
(`docs/specs/20260713-ws3-graph-expansion-decision.md`, verdict: KILL). The reasoning is
worth restating because it's easy to re-derive and re-propose without noticing it's the same
idea: FEAT-481's own design (`FEAT-481-design.md:504-511`) deliberately kept 1-hop expansion
out of v1 as a stated architectural taste ("keeping retrieval's default blast radius small
and opt-in"), with an explicit reopening bar of **real production usage evidence** — not "a
benchmark score, even a bigger/more-reliable one." The review's category-error argument:
LoCoMo multi-hop is 32 synthetic questions from one academic conversation, scored by a
harness whose own docstring says it "measures the memory system, not the LLM's world
knowledge" — improving that number does not manufacture the usage evidence the reopening bar
requires, no matter how the sample is resized. The downside is asymmetric too: single-hop (70
questions, already scoring higher than multi-hop) is the dilution target if expansion
degrades precision, and it's more than double multi-hop's mass.

**Do not propose entity_relations-based retrieval expansion again without new evidence of
the specific kind FEAT-481 asked for** (production telemetry, user-reported "it knew both
facts but didn't connect them" gaps) — a fuller LoCoMo rerun, even at full n=1986, is
explicitly named in that decision as *not* sufficient to reopen it.

What legitimately remains open, and is a **different** mechanism from the killed one: Lever
6 below (grounded/sequential decomposition) never touches `entity_relations` or adds
retrieval candidates from a graph traversal — it only changes *when* and *from what context*
the existing, already-sanctioned WS6 decomposer is invoked. That distinction is what keeps it
outside the WS3 kill's scope; blurring it would repeat the exact category error the kill
called out.

---

## 6. Sharpened multi-hop architecture: grounded/sequential decomposition (not entity_relations, not a rewrite of WS6)

Current WS6 decomposition (`decompose.ts:116-152`, `LlmQueryDecomposer`) is **structurally
blind**: one upfront LLM call splits the raw question into all sub-queries before any
retrieval happens, with zero knowledge of what hop 1 actually returns. For "what does the
person who gave Melanie the painting do for work?" it must guess both "who gave Melanie a
painting" and a plausible second sub-query for "what does that person do" — but it cannot
name the connecting entity, because it never sees hop 1's answer.

**Sharper design — retrieve-then-decompose-again, gated and bounded exactly like WS6
already is:**

1. Run today's cheap gate (`needsDecomposition`, `decompose.ts:244-247`) unchanged.
2. Issue the FIRST sub-query (or the raw question, if the decomposer yields none) through
   the existing single-pass `search()`.
3. **New step:** if hop 1's top hit's fused score clears a confidence floor, extract the
   entity/name most central to hop 1's returned text (cheap — reuse the existing `entities[]`
   already attached to atoms via `05-extract.ts`, not a new NER pass) and splice it into a
   SECOND decomposer call as grounding context ("hop 1 found: '{name}, {relation-ish
   phrase}'. Build a search query for: {remainder of the original question}").
4. Merge hop 2's results into the supplemental pool exactly as today
   (`search.ts:823-851`, same `maxSupplemental`/`supplementalWeight` damping — no change to
   the dilution bound).

This stays entirely inside `search()`'s existing multi-hop seam (same file, same governance
pattern, same `config.multiHop.*` knobs) — it extends WS6's contract (one more conditional
decomposer call, gated on hop-1 confidence) rather than reopening WS3's graph-expansion
question, because at no point does it read `entity_relations` or add candidates by edge
traversal; it only makes the *existing* decomposer's second call *informed* instead of blind.

**Rough estimate:** conditional on Lever 1 (turn on today's blind decomposition first) showing
*some* signal but falling short of the doc's 0.36→0.55 target — if blind decomposition helps
0 and grounding also helps 0, the mechanism itself is wrong for this benchmark and Track C
should be dropped entirely rather than iterated on. Measure Lever 1 before funding this.

---

## 7. Sharpened critical path

| Phase | What | Files | Change type | Acceptance criteria | Validation |
|---|---|---|---|---|---|
| 0 | Free precision/verbosity diagnostic (Lever 3) — offline, zero LLM calls, zero new instrument risk | new: `scripts/eval/locomo/diagnose-verbosity.mts` (reads existing archived `hypotheses.jsonl` + `sample.json`) | add | hypothesis:gold token-length ratio reported per category; single-hop ratio materially > temporal/adversarial ratio confirms the mechanism | `bun scripts/eval/locomo/diagnose-verbosity.mts --run-dir docs/eval-runs/20260719-chunkab-800tok` |
| 1 | Turn on existing decomposition, unmodified (Lever 1) | `sandbox-config.yaml` (or run config) only | config-only | multi-hop category score reported before/after, same-day, same recipe otherwise | rerun `run.mts` on conv-1, diff `metrics.json`'s category `1` row |
| 2 | Existing §5 retrieval-presence diagnostic, discounted by its own known 42% FN rate | none (already built) | run only | not-in-DB vs rank-miss vs rank-ok split reported for single-hop, with the FN caveat stated in the output | `bun scripts/eval/locomo/diagnose-retrieval.mts` against the current baseline's datadir |
| 3 | Reasoning-budget-aware, category-routed answerer, flag-gated (Lever 2) | `scripts/eval/locomo/answer.mts` (`answerConversations`, ~184-206), `judge.mts` optional follow-on | modify, additive flag only | `ANSWERER_CATEGORY_REASONING=1` run scores multi-hop + single-hop categories only; unset run byte-identical to today | same-day A/B, both runs archived via `archive-run.mts` |
| 4 | Grounded/sequential decomposition (Lever 6), only if phase 1 shows signal | `src/search/decompose.ts`, `src/search/search.ts` (merge block) | modify | multi-hop score vs phase-1's blind-decomposition baseline, single-hop floor held (mirrors the WS3 gate's own AC-4 discipline) | `tests/eval/retrieval-eval.test.ts` + LoCoMo conv-1 rerun |
| 5 | Track B scorer-format catalogue, reframed to include verbosity (not just ISO-date-class bugs) | `judge/metrics.mts` (measurement only — scorer itself is upstream-fidelity, don't change it) | analysis, no source change | catalogue of every hypothesis shape that scores 0.0 despite semantic correctness, verbosity-tagged | manual review of low-F1 rows post phases 0-3 |
| 6 | Variance-lock (doc's Track E, unchanged, still needed regardless of everything above) | eval harness only | process | median-of-3-day reporting standard adopted | 3x same-recipe reruns, `judge.mts --run-dir` x3 |

Phases 0-3 are all same-day, mostly config/measurement, near-zero implementation risk, and
**all precede** the doc's Track A/B/C investment — they should be run first because two of
them (0 and 1) might substantially change what Track A/B/C should even target.

---

## 8. Moonshot worth a spike: the scorer itself may be under-reporting the memory system's real quality

`judge.mts`'s own header comment says the quiet part out loud: *"token-F1 against a
full-sentence hypothesis is known to under-score answers that are semantically correct but
phrased differently from the terse reference answer... F1 alone is a harsher (not
necessarily wrong, just harsher) measure here than in the original paper's own reported
numbers."* The harness **already has** a semantic LLM-judge pass built for exactly this
(`judge.mts`'s `--llm-judge`, `runLlmJudge`) — it's additive, always available, and has never
been the reported number. It currently also runs at `reasoning_effort: 'minimal'`
(`judge.mts:102`), the same lever Lever 2 identifies as suspect, with the FEAT-450 precedent
(minimal→low, measured win) sitting right there unapplied.

**The spike:** re-score an *already-archived* `hypotheses.jsonl` (no re-ingest, no re-answer,
no new LLM spend on the memory system itself — only the judge calls) with
`bun judge.mts --run-dir docs/eval-runs/20260719-chunkab-800tok --llm-judge`, once as-is and
once with the judge's `reasoning_effort` bumped to `'low'`. Cost: a few dollars, ~20 minutes,
zero code changes (the flag exists).

**Why this could reframe the whole campaign:** if the semantic judge scores single-hop
meaningfully higher than 0.49 on the *same* hypotheses already sitting on disk, it means a
material fraction of the "gap" is a **scoring-instrument** artifact (verbose-but-correct
answers, valid paraphrase, the exact failure mode Lever 3 predicts mechanically) rather than
a memory-system deficiency — and the 0.70 target on raw token-F1 may be the wrong target
entirely, or achievable with far less answerer/extraction work than the doc's multi-week
campaign budgets for. If it *doesn't* move the number, that's equally valuable: it rules out
"it's just a scoring artifact" cleanly and validates that the doc's Track A/B investment is
aimed at a real gap. Either outcome is worth having before committing weeks to Track A.

---

## 9. Summary — direct answers to the mandate

1. **Highest-upside levers the doc missed:**
   - Multi-hop decomposition (WS6, #266-fixed) has **never been measured on** and isn't in
     the current baseline's config at all — turning it on is free and untried (§1).
   - Reasoning-effort/token-budget misconfiguration on the frozen answerer (`'minimal'`,
     150-token shared budget) is a concrete, precedented (FEAT-450), low-risk mechanism for
     the doc's vague "answerer overhaul," with a specific per-category routing design (§2).
   - Precision-vs-verbosity is a third, scorer-mechanistic explanation for single-hop's
     weakness that the doc's (a)/(b) binary collapses, and it's checkable for free against
     data already on disk (§3).
2. **Does fixing FTS raise the ceiling?** No — same-day evidence (FEAT-480) shows reviving
   it trades plain-English recall for literal-keyword precision and junk; it's correctly
   deferred, not a rising-tide fix (§4).
3. **Sharpened critical path:** run phases 0-2 (all free/near-free measurement) before
   funding Track A/B/C at all — they may change what those tracks should target, and phase 1
   in particular is a config-only experiment the doc doesn't mention exists (§7).
4. **Moonshot:** re-score an already-archived run with the existing `--llm-judge` flag at
   `reasoning_effort: 'low'` — could reveal the real gap is smaller (or differently shaped)
   than raw F1 shows, for the cost of a spike, not a campaign (§8).

**Explicit non-recommendation:** entity_relations graph traversal for multi-hop — already
killed 2026-07-13 on a categorical-evidence argument that a LoCoMo-only re-derivation cannot
clear (§5).

## Provenance

Doc under review: `docs/research/20260719-locomo-0.70-research-for-cross-review.md`. Code:
`src/search/decompose.ts`, `src/search/search.ts:713-1080`, `src/config/config.ts:370-381,1493-1496,2455-2479`,
`src/storage/entity-relations.ts`, `scripts/eval/locomo/answer.mts`, `scripts/eval/locomo/judge.mts`,
`scripts/eval/locomo/judge/metrics.mts`, `scripts/eval/shared/azure-client.ts`,
`scripts/eval/locomo/diagnose-retrieval.mts`. Artifacts: `.claude/artifacts/loop/backlog/pending/FEAT-480.md`,
`.claude/artifacts/crew/runs/20260719T173108Z-final-synthesis-feat-480-*.md`,
`docs/specs/20260713-ws3-graph-expansion-decision.md`, `docs/specs/FEAT-481-design.md`,
`docs/eval-runs/20260719-chunkab-800tok/{metrics.json,sandbox-config.yaml}`. Team memory
(astramem `recall_memory`): decision `8323528c` (WS6 over graph-expansion), decision
`6d9b6fae` (frozen answerer), lesson `ac5a0b29` (2026-07-14 single-hop-is-extraction finding,
flagged as possibly stale), event `f33f4115` (WS5/WS6 "built, shipped, never switched on").
