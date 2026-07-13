# LoCoMo score-improvement — architect design (2026-07-13)

Status: **DESIGN — for review**. Companion to `docs/specs/20260713-locomo-score-plan.md`
(the PM plan with measured baseline evidence). This doc answers the plan's
open questions with file:line evidence and proposes a design per workstream.
No source was edited to produce this — every claim below is a citation, not
an inference.

Benchmark-integrity constraint carried over unchanged: `answer.mts:38-52`
(`buildAnswerPrompt`) passes ONLY `h.text` to the answerer. Nothing below
proposes touching the answerer. Every fix targets what gets **stored**
(atom text) or what gets **retrieved** (candidate set / ranking).

---

## Workstream 1 — Temporal (est. +7 pts)

### The plumbing question, answered

The session date **does** reach the pipeline — it does **not** reach the LLM
that writes atom text. Traced end to end:

1. `src/server/routes/ingest.ts:73` — canonical envelope requires
   `captured_at` (ISO-8601). `:327` computes `capturedAtMs = new
   Date(data.captured_at).getTime()` and stores it on the `transcripts` row.
2. `src/pipeline/handlers/distill.ts:120-124` — reads `transcript.captured_at`
   back off that row and sets `PipelineContext.capturedAtMs`.
3. `src/distill/pipeline.ts:48-49` documents this exact chain: *"See
   EmbedIndexContext.capturedAtMs — plumbed from the canonical envelope via
   distillHandler."* `:225` passes it straight through to stage 8.
4. `src/distill/stages/08-embed-index.ts:42-50` (doc comment) + `:201`
   (`valid_from: ctx.capturedAtMs ?? undefined`) — becomes the memory's
   bitemporal `valid_from`. `:246` also seeds `entity_relations.valid_from`.

That's the entire journey. `capturedAtMs` is only ever consumed by stage 8
(a DB column) — it is **never** passed to stage 3 (`chunk`, `03-chunk.ts` —
takes only `text`), stage 4 (`compact`, `04-compact.ts:56` — `compactChunk(chk,
provider, budget, capUsd)`, no timestamp param), or stage 5 (`extract`,
`05-extract.ts:89-101` — `extractChunk(chunkIndex, text, provider, budget,
capUsd, extractProfile)`, no timestamp param either).

The codebase already says this out loud. `src/distill/prompts/extract.ts:235-242`,
in the conversational prompt's own doc comment:

> *"captured_at is NOT currently threaded into this call (05-extract.ts's
> extractChunk receives no timestamp ...). Wiring an actual captured_at into
> the extraction prompt is a natural follow-up once a real anchor value is
> threaded this deep."*

And the prompt text itself (`extract.ts:267`, conversational profile) hedges
accordingly: *"if the transcript states or implies an explicit
observation/capture date ... If no such anchor appears anywhere in the
transcript, keep the original relative phrasing."* Since the anchor is never
injected, this rule almost never fires — which is exactly the 19.9%-with-a-date,
100%-unresolved measurement in the PM plan. **This is not a new discovery;
it's a documented, acknowledged gap with a name and a location.** FEAT-486's
premise (a retrieval-side `as_of` fix) is the wrong diagnosis — the fix
belongs at extraction, and `valid_from` (the retrieval-side bitemporal value)
is **already populated correctly today** (step 4 above). Nothing needs to
change there. Recommend re-scoping or closing FEAT-486 in favor of a new
FEAT scoped to extraction-time date anchoring.

### Design: prompt-level resolution, not a deterministic post-pass

The plan's own open question — prompt-level vs. deterministic post-pass —
resolves clearly in favor of prompt-level:

- A deterministic post-pass would need to (a) parse natural-language relative
  expressions ("yesterday", "last year", "this morning") against an anchor,
  which a date library can do, **and** (b) rewrite them in place inside a
  full prose sentence without breaking grammar ("she painted it last year" →
  "she painted it in 2022" is a text-surgery problem, not just a parsing
  problem). That's a new dependency plus a non-trivial NL rewrite step.
- The LLM is already composing that exact sentence in the same extraction
  call. Handing it the anchor costs nothing extra (no new LLM call, no new
  provider) and it produces grammatically correct output by construction —
  it's already the thing doing the writing.

### Proposed change (small, additive, backward-compatible)

1. `05-extract.ts`: add an optional `sessionDateIso?: string` param to
   `extractChunk` and `extract`. When present, prepend one line to the user
   message built at `callExtract` (`extract.ts:139-142`, currently
   `"Extract knowledge atoms from this transcript chunk:\n\n${text}"`):
   `"Observation date: ${sessionDateIso}\n\n" + ...`.
2. `pipeline.ts` stage-5 call site (`:155-158`): format
   `ctx.capturedAtMs` (already on `PipelineContext`, `:49`) as an ISO date
   (`new Date(ms).toISOString().slice(0,10)`) and pass it through. `undefined`
   when `capturedAtMs` is null (legacy v0.0 envelopes, `/remember` calls) —
   byte-identical to today for every caller that has no session date.
3. `prompts/extract.ts`: tighten the conversational profile's date-grounding
   rule (`:267`) from conditional ("if the transcript states or implies…") to
   point at the injected line directly when present, falling back to the
   existing conditional wording when it's absent (legacy envelopes still need
   the hedge). Same tweak for the engineering v3 prompt's equivalent rule
   (`:581-584`) for consistency, though it matters far less for LoCoMo.
4. No change needed to `compact` (stage 4) or `chunk` (stage 3) — compaction
   doesn't need to resolve dates, only extraction does, so the anchor only
   needs to reach the one call that writes final atom text.

**Files touched:** `src/distill/pipeline.ts`, `src/distill/stages/05-extract.ts`,
`src/distill/prompts/extract.ts`. **Size: small** (a few hours to a day,
including prompt-wording tests). **Risk: low** — purely additive optional
param, undefined preserves current behavior exactly for every non-canonical
caller.

**Dependencies:** none. Ships first.

---

## Workstream 2 — Single-hop precision (est. +5 pts)

### No root cause yet — and it's cheap to get one without touching prod code

`POST /recall`'s limit is **uncapped**: `src/server/routes/search.ts:72-73`
— `k: z.number().int().positive().optional()`, `limit:
z.number().int().positive().optional()` — no `.max()`, unlike `GET /search`
which clamps to `Math.min(100, ...)` at `:143`. `search()` itself
(`src/search/search.ts:387`) sets `vecK = Math.max(limit * 4, 50)` — so a
diagnostic call with `limit: 500` gives `vecK = 2000`, almost certainly
larger than the total atom count of any single LoCoMo conversation's project
(CLAUDE.md: ~10 atoms/session; a conversation with 20-30 sessions is on the
order of 200-300 atoms). **In practice this returns the complete,
untruncated fused ranking for that project — no candidate-window blind
spot.** This means the "ranked below k=10 vs. never retrieved" split the plan
asks for is answerable with **zero production code changes** — a pure
eval-side instrumentation script.

LoCoMo's own schema gives a ground-truth anchor for free:
`scripts/eval/locomo/lib/types.ts:73-86` — every `LoCoMoQA` carries
`evidence: string[]`, dialog ids (`"D3:5"` = session 3, turn 5) the answer is
grounded in, plus the reference `answer` string itself. That's enough to
build an automated diagnostic without any manual labeling.

### Proposed diagnostic (new eval script, no prod changes)

New script, e.g. `scripts/eval/locomo/diagnose-retrieval.mts`:

1. For every category-4 (single-hop) QA with a defined `answer`, call
   `recall()` (`scripts/eval/shared/daemon-client.ts:84-96`) with `limit: 500`
   (or higher) scoped to the same `project` filter `answer.mts:80` already
   uses.
2. Reuse `normalizeAnswer` / stemming from `judge/metrics.mts:43-52` (already
   Porter-stemmed, already the exact normalization the real scorer applies)
   to tokenize the reference answer.
3. Walk the full ranked hit list; for each hit compute token-overlap
   (recall of answer tokens against hit text tokens, same stemmer). The
   **first** hit above a containment threshold (e.g. ≥0.6 of answer tokens
   present) is treated as "the atom that should answer this question."
4. Classify the question into exactly one bucket:
   - **not-in-DB** — no hit at any rank (up to the full-project limit)
     contains the answer tokens at all → the fact was never captured as a
     distinct atom (extraction miss, or it was captured but phrased so
     differently that no token overlap survives — worth eyeballing a sample).
   - **rank-miss** — found, but at rank >10 → a fusion/ranking problem
     (opposite fix: rerank tuning, weight tuning), the atom exists and is
     embedded/indexed fine.
   - **rank-ok** — found at rank ≤10 → retrieval already worked; a wrong
     answer for this question is an answerer-side or ambiguity problem, not
     a memory-system problem (out of scope per the benchmark-integrity
     constraint).
5. Report the 3-way split, overall and per-category, so effort is spent
   on whichever bucket dominates.

This script is deliberately category-agnostic (take `category` as a filter
argument) — it services workstream 4 (open-domain) for free once real
open-domain volume exists (see WS4 below), no separate tooling investment.

### Fix directions (deferred until the diagnosis actually runs)

- If **rank-miss** dominates: `src/search/rerank.ts` already ships a
  cross-encoder rerank stage, currently **off by default**
  (`src/config/config.ts:499` — `crossEncoder: { enabled: false, provider:
  'mock', ... }`). Turning it on (with a real HTTP sidecar, not the mock
  Jaccard stand-in at `rerank.ts:62-73`) is a ready-made lever — no new
  architecture needed, just an eval-gated config flip. Alternatively, retune
  `alpha`/`beta` fusion weights (`config.ts:496`) if the miss is systematic
  rather than a top-K-ordering nuance.
- If **not-in-DB** dominates: the fix is upstream of search entirely —
  either extraction is under-capturing single facts (check against the
  conversational profile's "liberal extraction" posture,
  `prompts/extract.ts:260`) or embedding/chunking granularity is burying a
  fact inside an atom whose primary subject is something else. This would be
  a distill-side fix, not a search-side one — the opposite of the rerank
  fix above, which is exactly why the plan is right to insist on diagnosis
  before a remedy.

**Files touched (diagnosis phase):** one new eval script, no `src/` changes.
**Size: diagnosis ~0.5-1 day.** Fix size unknown until diagnosis runs — don't
estimate blind, per the plan's own instruction.

**Dependencies:** should be **re-run after WS1 ships**, not just built in
parallel. WS1 changes atom text broadly (date-anchored sentences are longer
and phrased differently) which can shift single-hop lexical/embedding match
either direction — diagnosing against pre-WS1 atoms risks chasing a moving
target.

---

## Workstream 3 — Multi-hop 1-hop graph expansion (est. +2 pts)

### Confirmed: built, wired, never invoked

`migrations/027-entity-relations.sql` creates `entity_relations`, populated
at write time by `src/distill/stages/08-embed-index.ts:238-265` (every
FEAT-481 relation triple the extractor emits gets persisted). Read-side
primitives already exist and are non-trivial: `src/storage/entity-relations.ts`'s
`EntityRelationRepo.getForEntity` (`:155-176`) does a bitemporal-aware 1-hop
lookup (`direction: 'subject'|'object'|'both'`, `asOf`-joined against the
evidence memory's own validity window). The doctor canary
(`src/doctor/checks.ts:1199-1230`, `checkEntityRelations`) exists
specifically to detect "populated but never read," which is precisely the
state today.

Confirmed absent: `src/search/search.ts` never imports or queries
`EntityRelationRepo` or `entity_relations` anywhere in its candidate-gathering
or fusion path (only `EntityRepo`, for the ζ entity-bonus over
`memory_entities`/`entities` — a different, one-hop-simpler table). Multi-hop
retrieval today is exactly what BM25+cosine on a single query embedding can
find — no traversal.

### Design

Gate behind a new config flag (mirrors the ζ/η governance pattern already
established for entity-bonus and agent-bonus — `config.ts:103-104`,
`applyFusionGovernance`), default **off**:

1. After the query-matched-entity step search() already computes for the ζ
   bonus (`entityBonusForQuery`, `search.ts:325-342`, only currently run when
   `zeta > 0`) — reuse or generalize that same entity-resolution step
   regardless of zeta when graph expansion is enabled.
2. For each matched entity id, call `EntityRelationRepo.getForEntity(id, {
   asOf, limit })` to get 1-hop neighbor entity ids.
3. Resolve neighbor entities' linked memories (`EntityRepo`'s existing
   `memoryIdsForEntities`, already used by the `entity` filter path at
   `search.ts:453-456`) and union those memory ids into the FTS∪vec candidate
   set **before** fusion — but tag them as graph-sourced and give them a
   bounded, config-capped contribution (a new bonus term, not full fused-score
   parity) rather than letting them compete unbounded with direct hits, since
   they're one hop removed and not independently query-relevant.
4. Cap the expansion (e.g. `graphExpansion.maxExpanded`, small default like
   10-20) to bound both cost and precision dilution.

**Files touched:** `src/search/search.ts` (new optional expansion step),
`src/config/config.ts` (new config block + governance), tests/search fixtures
with `entity_relations` rows, `tests/eval/retrieval-eval.test.ts` (new
category to catch a regression).

**Risk (explicitly named in the plan, confirmed real):** the expanded
candidate set is the *same* candidate set single-hop questions run through —
adding neighbors that dilute precision on WS2's now-diagnosed single-hop
bucket is a real and measurable risk, not a hypothetical one. Must be
evaluated with the existing ADR-005 harness (recall@10 ≥ 0.9, NDCG@10 ≥ 0.7
regression floors, per CLAUDE.md) gating **both** single-hop and multi-hop
metrics before flipping the default, not multi-hop alone.

**Size: medium** (~1.5-2 days including the eval-gated rollout comparison).

**Dependencies:** sequence **after** WS2's fix lands (not just WS2's
diagnosis). The stated risk can only be honestly measured against a
single-hop baseline that's already in its best state — evaluating WS3
against a single-hop baseline still carrying an unfixed rank-miss or
not-in-DB problem would misattribute WS3's net effect.

---

## Workstream 4 — Open-domain recall miss (est. +1.8 pts)

**Not worth designing yet — say so plainly.** n=13, of which only 6 were
answered; the headline 0.73 answered-F1 rests on 6 questions. That's not
enough signal to design a targeted fix against — any "fix" built now would be
overfit to six data points from one conversation's 10% sample.

The plan's own global caveat already flags this category as needing the
full-sample rerun before its sizing can be trusted at all. No new design
work is justified until that rerun exists. The right move is procedural, not
technical: **defer**, and when full-sample numbers exist, run WS2's
diagnostic script (already built category-agnostic, `diagnose-retrieval.mts
--category 3`) against category-3 questions — this costs nothing extra since
the tooling investment was already made for WS2. If the miss is confirmed at
10x the sample size and still shows the not-in-DB/rank-miss split cleanly,
design a fix then, informed by real data.

**Size: zero right now.** Re-evaluate after the full-sample rerun.

---

## Workstream 5 — Abstention calibration (cross-cutting)

Confirmed mechanically: `judge/metrics.mts:82-87` — adversarial scoring is a
**binary substring check** (`isAbstentionPhrase`) against exactly two phrases
the answerer's own prompt is instructed to emit verbatim
(`answer.mts:45` — `'no information available'`). Adversarial questions are
23.6% of the whole benchmark and currently score 83.0 **by abstaining**. Any
change that makes retrieval surface more content on borderline/ambiguous
queries — which is what "abstain less" would require — risks answering some
of those adversarial questions instead of correctly declining them, trading
the 83.0 straight back. This is a real trap, not a hypothetical one, and it
cuts against any workstream that increases retrieval recall indiscriminately
(most concretely, WS3's expansion and any aggressive fusion-weight retune
from WS2).

**Recommendation: not an independent workstream.** It is a measurement to
take *after* WS1-3 land, not a build. Re-run the non-adversarial abstention
rate (39/152 baseline) once WS1-3 are in; fund a targeted fix only if a
residual, isolable cause remains that isn't already explained by "the fact
genuinely wasn't retrievable" (WS2/WS3's problem) or "the date wasn't
resolvable" (WS1's problem). A global confidence-threshold knob is
structurally the wrong shape for this — it can't distinguish "abstained
because nothing relevant was retrieved" (correct) from "abstained because
the answerer wasn't confident enough despite good retrieval" (wrong) without
first fixing retrieval, which is what WS1-3 already do.

**Size: zero build now** — a measurement checkpoint after WS1-3, not before.

---

## Recommended build order

1. **WS1 (temporal fix).** No dependencies, small, low-risk, highest
   estimated point value. Ship first.
2. **WS2 diagnosis script.** Build in parallel with #1 (no code overlap —
   pure eval tooling) but hold off running the real analysis until after
   WS1 ships and a fresh eval run exists, since WS1 changes atom text broadly.
3. **Full-sample LoCoMo rerun** (the plan's own global caveat — n=199/1
   conversation is too thin to trust several of these estimates). This also
   gives WS4 the sample size it currently lacks.
4. **WS2 fix**, informed by the diagnosis + fresh full-sample data.
5. **WS3 graph expansion**, sequenced after WS2's fix (not just its
   diagnosis) so its stated precision-dilution risk is measured against a
   single-hop baseline that's already in its best state, gated on the
   existing ADR-005 recall@10/NDCG@10 floors for both single-hop and
   multi-hop jointly.
6. **WS4**, revisited once the full-sample rerun (#3) gives it enough n —
   reuses WS2's tooling at near-zero extra cost.
7. **WS5**, measurement-only, after 1-3 land — fund a build only if a
   residual, isolable cause remains.

**Why this order and not effort-first or point-value-first:** WS1 is both
the highest point estimate and a hard prerequisite for trusting WS2's
diagnosis (atom text changes shift retrieval), so it has to go first
regardless of sizing. WS3 is explicitly gated on WS2 by the plan's own stated
risk (candidate dilution), not a scheduling convenience — building them in
the reverse order would produce an eval comparison that can't be trusted.
WS4 and WS5 are both explicitly data-starved or consequence-only per the
plan, and manufacturing designs for either now would be inventing
work against evidence too thin to justify it.
