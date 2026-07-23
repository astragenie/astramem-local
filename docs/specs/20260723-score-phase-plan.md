# Score-phase plan — fuse robust-normalization + multi-scope evidence bundling (2026-07-23)

Design-only. No source touched. Builds on `docs/specs/20260720-retrieval-overhaul-plan.md`
(Phases 4-6, Wave 2), the oracle-factorial findings (`docs/eval-runs/20260720-oracle-factorial/README.md`),
the 2026-07-22 rerank/decompose same-store A/B ledger rows, and memories `fusion-pool-tax-score-lead`,
`retrieval-fusion-refuted`, `retrieval-enable-needs-hardening`, `extraction-noise-conv26`,
`eval-cheap-stack-only`.

## 0. The crux, restated precisely

Two independent, previously-unconnected findings now fit one story:

1. **The oracle ceiling.** With the frozen cheap answerer, PERFECT single-cited-turn evidence
   (gold-turns) caps overall at 0.75 (CoT-judge scale) / ~0.53 (cheap-judge scale). Ranking atoms
   better cannot cross this — it needs evidence the single cited turn doesn't contain.
2. **The broaden-recall tax.** Every lever that adds candidates to the ranking pool (real-ONNX
   rerank, mock/LLM decompose) helps its target category and taxes the rest, net ~0 overall,
   **and specifically breaks adversarial abstention** (0.872 → 0.723–0.851). `fusion-pool-tax-score-lead`
   traces a live mechanism: `fuse.ts`'s naive min-max normalization lets one high-magnitude/junk
   candidate invert the ranking of two unrelated candidates whose own signals never changed.

The two items below are ordered to attack (2) first — cheaply, because it may be *why* every past
attempt at (1)'s prerequisite (broadening what the answerer sees) has washed — then attack (1)
directly, with a bundling design chosen specifically so it does **not** reopen (2).

---

## 1. Track I — fuse robust-normalization experiment (do this first)

### 1.1 The bug, precisely

`src/search/fuse.ts::normalizeScores` (`fuse.ts:117-127`) is plain min-max:

```ts
const min = Math.min(...scores);
const max = Math.max(...scores);
return scores.map(s => (s - min) / (max - min));
```

SQLite's `bm25()` is unbounded and unnormalized across queries. `fuseHits` calls this once per
independent candidate pool (`fuse.ts:189-272`), and `search.ts` deliberately keeps WS6 decompose
supplemental hits and each query-rewrite variant in their **own** `fuseHits()` call precisely to
avoid one pool's magnitude spread contaminating another's (`search.ts:973-991`, `:1006-1021`
comments). That isolation is real and correctly reasoned — but it only protects *across* pools, not
*within* one. Within a single `fuseHits()` call, one candidate with an outlier raw `bm25`/`cosine`
value stretches `[min, max]` and compresses every other candidate's normalized score toward the
middle, which can invert the relative order of two candidates whose own raw scores never changed.
Reproduced live 2026-07-23: `{A: 0.56, B: 0.55}` (A ranks above B) flips to B-above-A purely by
adding an unrelated junk/duplicated candidate C to the pool.

The debug/explain projections (`search.ts:1103-1162` and `:1173-1197`) independently recompute
`normalizeScores` over the SAME `filteredFtsHits`/`filteredVecHits` arrays as the main fuse call —
they are downstream views, not a second bug, but any normalization change must keep all three call
sites (`fuseHits`'s internal call, the debug projection, the explain projection) using the *same*
function or `SearchDebugHit.score` stops matching `SearchHit.score` for the same query.

### 1.2 Why this is the likely mechanism behind "every broaden-recall lever washes"

`search.ts:1071` builds `rankedFused` (primary fused + damped supplemental) and rerank's `topK`
window (`rerank.ts:367`, `search.ts:1171` `buildLimit`) is sliced from *that* merged, single list.
Adding decompose/rewrite candidates doesn't retaint the primary pool's own min-max (each pool
normalizes separately, per 1.1) — but it does change **how many and which** candidates compete for
the fixed-size reranker window once merged, and separately, anything that widens a *single* pool
(e.g. P0.2's FTS analyzed-query change, or a looser `vecK`) hits the within-pool inversion directly.
Both are consistent with the observed pattern: a lever that helps the category it targets while
re-ranking unrelated categories down, with no obvious causal link between the two — pool
contamination doesn't care what category a candidate belongs to.

### 1.3 Candidate normalization designs

| design | mechanism | pros | cons |
|---|---|---|---|
| **A. Winsorized/clipped min-max** (recommended primary) | clip raw scores to `[p5, p95]` (or median ± k·MAD) before the existing min-max | smallest code change; keeps magnitude information *within* the non-outlier band (unlike rank-based); directly neutralizes the reproduced bug (one outlier can no longer stretch the whole range) | needs a clip-quantile/MAD constant to pick; degenerate on tiny pools (n<4) — must fall back to plain min-max there |
| **B. Rank-based (percentile)** normalization | `normalized = 1 - rank/n` (or similar ordinal mapping) | fully immune to magnitude outliers by construction; simplest to reason about | **this is exactly what P1's RRF attempt already tried and REFUTED** (`retrieval-fusion-refuted`: "many multi-hop atoms are near-tied in raw magnitude; ordinal RRF loses that", multi-hop 0.28→0.15-0.21) — do not re-propose pure rank-based fusion; only worth re-testing narrowly as a per-component ablation arm, not as the shipped candidate |
| **C. Robust z-score + logistic squash** | `(x - median) / (1.4826·MAD)`, then `sigmoid` to `[0,1]` | theoretically cleanest; smooth, no hard clip boundary | new failure mode when MAD≈0 (near-identical scores, the common case per `normalizeScores`'s own existing `range === 0` special-case) — needs its own epsilon-guard; harder to explain in the debug/explain projections consumers already read |

**Recommendation: implement A, and only A, for the first A/B.** B is functionally a re-run of the
already-refuted RRF experiment and should not consume budget again. C is a reasonable follow-up
*if* A under-delivers, not a parallel arm — running 3 arms at once multiplies noise exposure for a
lever this cheap to iterate on serially.

### 1.4 Implementation shape (design, not code)

- New `search.normalization: 'minmax' | 'winsorized'` config key (default `'minmax'`), same
  governed-additive posture as `crossEncoder`/`multiHop`/`queryRewrite` (`config.ts:361-444`) — a
  config surface that takes zero extra branches when left at default, so every existing behavior
  and test stays byte-identical until someone opts in.
- Touches **only** `src/search/fuse.ts` (`normalizeScores`, gated on the new option) — no schema
  change, no migration, no new table. `search.ts`'s three call sites (`fuseHits` internal,
  `:1108-1114` debug, `:1179-1184` explain) all thread the same resolved option through, so they
  stay mutually consistent per 1.1's caveat.
- **Test-first**: encode the reproduced `{A,B}+junk-C` inversion as a regression test in
  `tests/search/fuse.test.ts` BEFORE the fix lands (red under `minmax`, green under `winsorized`) —
  this is the concrete artifact that proves the bug is real and stays fixed, not just an eyeballed
  A/B delta.

### 1.5 Measurement plan

- **No re-ingest required** — this is a pure ranking-math change, so unlike extraction-side levers
  it is **not** subject to the ±4.3-pt `extraction-noise-conv26` band. It CAN be measured same-store,
  same-day, immediately, the same way the 2026-07-22 rerank/decompose same-store A/Bs were done
  (`.eval-data/locomo/runs/20260722-cot-conv-liberal/`, 329-atom store). Residual noise is only the
  much smaller answerer-nondeterminism floor (±0.008 overall / ±0.02 on the n=32 multi-hop slice,
  per the 2026-07-23 handoff) — real but far below extraction noise.
- **Gate**: ADR-005 floors must hold (`tests/eval/retrieval-eval.test.ts`, mean recall@10 ≥ 0.929
  regression floor / mean NDCG@10 ≥ 0.748 regression floor, per that file's existing baseline) —
  this is a hard CI gate already in place, not new infrastructure.
- **A/B matrix** (same store, cheap stack — `eval-cheap-stack-only`):
  1. `minmax` (control) × rerank off — reproduces the 0.5883 baseline row exactly (sanity check).
  2. `winsorized` × rerank off — isolates the pure normalization effect with no reranker interaction.
  3. `minmax` × rerank onnx — reproduces the known 0.5716 / adversarial 0.723 regression row.
  4. `winsorized` × rerank onnx — **the interesting cell**: tests whether fixing the pool-tax also
     repairs the reranker's adversarial abstention break, which would mean the reranker's real value
     (already confirmed, `retrieval-fusion-refuted`) was being partially hidden by this bug all along.
- **Decision rule**: keep `winsorized` as the new default only if (2) beats (1) on token-F1 outside
  the noise band AND (4) shows adversarial materially recovering toward 0.872 relative to (3) — a
  win on (2) alone without movement on (4) is still bankable (ship as a quality fix) but does not
  change the "reranker unlockable" verdict; a win on (4) is the headline this experiment is really
  fishing for.

---

## 2. Track #6 — multi-scope evidence bundling

### 2.1 Correcting the storage citation (citation-drift note, CLAUDE.md policy)

The originating ask cites "`evidence_span` (mig 056)" and "`entity_relations` (mig 057, the bridge
fact for multi-hop)" — verified against current migrations, this is transposed:

- **Migration 057** (`057-evidence-provenance.sql`) — `memories.evidence_turn_index` /
  `evidence_char_start` / `evidence_char_end` / `evidence_span`. This is the exact-source-turn
  provenance.
- **Migration 056** (`056-memory-links.sql`) — the `memory_links` table (atom-to-atom, deterministic,
  `link_type ∈ {shared_entity, session_proximity, possession_family, event_participant}`).
- **`entity_relations`** is neither — it's **migration 027** (FEAT-481, pre-existing before the
  2026-07-20 retrieval-overhaul work), a directional subject/predicate/object entity-to-entity
  table. Migration 056's own header comment explains why it's a *separate* graph from
  `entity_relations`: the latter only connects two entities BOTH named in one atom's LLM-asserted
  `relations[]` (too narrow for conversational multi-hop, where the bridge is often "these atoms
  share a person" rather than an explicit triple).

All three are real, live, and validated on the v3 store (94 evidence_span / 22 entity_relations /
1027 memory_links, `retrieval-fusion-refuted`) — the bundle design below uses all three, just
correctly attributed.

### 2.2 What's actually queryable today (verified, not assumed)

- `EntityRelationRepo.getForEntity(id, {direction, asOf, limit})` (`src/storage/entity-relations.ts`) —
  bitemporal-aware, already joins against the evidence memory's own validity window.
- `MemoryLinkRepo.getForMemory(memoryId, limit)` (`src/storage/memory-links.ts`) — every link row
  touching one memory, either position, with `link_type` + human-readable `evidence` string.
- **Adjacent transcript turns are reconstructable, not stored redundantly.** `transcripts.content`
  (migration 001, live table — NOT one of the FEAT-493 dead tables) holds the raw
  `JSON.stringify(turns)` per ingested envelope; `flattenTranscriptContent`
  (`src/distill/flatten-turns.ts`) is a **pure, deterministic** function already run once at ingest
  to build the `role: text` line-per-turn string that `evidence_turn_index` indexes into
  (`pipeline.ts:751` passes this same flattened string as `EmbedIndexContext.sourceText`, which
  `locate-evidence.ts` — migration 057's producer — splits on `\n` and indexes by line). A bundler
  can therefore, at READ time: look up the `transcripts` row for `memories.session_id` +
  `memories.source_hash` (source_hash disambiguates *which* transcript row when a session ingested
  more than once — never key on `session_id` alone), re-run `flattenTranscriptContent`, and slice
  `[turnIndex-1, turnIndex, turnIndex+1]` — no new column, no new table, no migration.
  **Open verification item before implementation**: confirm `evidence_turn_index` is scoped to the
  FULL per-session flattened transcript (this reads true from `pipeline.ts:751`'s `sourceText:
  transcript`, not a per-chunk substring, but re-verify directly against `08-embed-index.ts`'s
  `EmbedIndexContext` wiring before relying on it — this repo's own citation-drift caution applies).

### 2.3 Bundle assembly — where it runs matters more than what it contains

**Design decision, and the answer to the "hard design requirement": run bundling strictly AFTER
final top-K selection (post-rerank), as an enrichment pass over already-decided results — never as
a candidate-gathering step that broadens what gets ranked.**

Every past broaden-recall lever (WS6 decompose, query-rewrite, PRF neighbor-expansion) inserted
*more candidates into the ranking/fusion path*, which is exactly the pool Track I's bug — and,
independent of that bug, the pool `fuse.ts`/rerank operate over — lives in. That's the mechanical
reason each one taxed adversarial. Evidence bundling does not need to touch ranking at all: its
job is to attach *more context text* to atoms the pipeline has *already decided* belong in the
answer, not to change which atoms those are. Concretely:

```
search()  →  fuse  →  [rerank if enabled]  →  final top-K (UNCHANGED by this feature)
                                                    │
                                          evidenceBundle enrichment (NEW, post-selection)
                                                    │
                                    bundle: { anchor, sourceTurn, adjacentTurns[],
                                              linkedAtoms[] (memory_links + entity_relations),
                                              temporalNeighbors[] }
                                                    │
                                          answerer consumes grouped chains
```

Per selected top-K atom (bounded fan-out, cheap — all local SQLite reads, no LLM call):

1. **Anchor** — the atom itself (already have it).
2. **Source-turn expansion** — if `evidence_turn_index` is present: reconstruct the flattened
   transcript (2.2) and pull turns `[idx-1, idx, idx+1]` from the SAME session/source_hash.
3. **Graph expansion (the multi-hop bridge)** — `MemoryLinkRepo.getForMemory(atom.id)` for the
   generic "these are near each other" bridge (shared_entity/session_proximity/possession_family/
   event_participant), PLUS `EntityRelationRepo.getForEntity` for any entity the query text itself
   names (directional, higher-precision bridge) — cap at ≤2 non-generic bridge atoms per anchor,
   mirroring the original plan's Phase 4 bound, and require every included link to carry its own
   `evidence`/`source_excerpt` (both tables already guarantee this by construction).
4. **Temporal neighbors** — for atoms with populated `valid_from`, atoms sharing an entity with
   `valid_from` within a small window; reuses existing bitemporal columns, no new query primitive.
5. **Local rerank under one shared token budget** — score the assembled bundle's pieces (source
   turn + linked atom excerpts) against the query with the SAME cross-encoder already wired
   (`rerank.ts`'s `CrossEncoderProvider`), reusing `buildRerankCandidateText`'s pattern; keep only
   what fits a `maxBundleTokens` cap (same bounded-excerpt discipline as
   `MAX_EVIDENCE_EXCERPT_CHARS`, `search.ts:279`), truncating lowest-scored pieces first.
6. **Wire shape** — bundle provenance is additive on `SearchHit`/the recall response (new optional
   field, e.g. `bundle`), never replacing `text`/`evidence`/`evidence_span` — an answerer or
   consumer that doesn't know about it sees byte-identical output to today.

### 2.4 The actual hard part — not breaking abstention

Because bundling (2.3) cannot change *which* atoms are selected, it structurally cannot broaden
*recall* the way rerank/decompose did — the category-tax mechanism has no foothold here. The
residual risk is narrower and different in kind: **an already-selected, genuinely-irrelevant
top-K atom (the thing that's supposed to make the answerer say "I don't know") now arrives with
MORE surrounding context** (adjacent turns, linked atoms), and that extra context could read as
corroborating evidence to the answerer even when the anchor itself was noise — i.e., bundling could
manufacture false confidence out of volume, not out of a ranking change.

Two complementary mitigations, meant to run together (not alternatives):

- **(a) Confidence-gated bundling (structural, no LLM cost).** Only enrich an anchor whose own
  fused/rerank score clears a floor — an anchor that barely made top-K (the profile of an
  adversarial "nothing good exists" slot) gets returned exactly as it is today (plain atom, no
  bundle), preserving the current 0.872 abstention rate for that class of hit by construction,
  since nothing about its representation changes. This is NOT a repeat of the already-REJECTED
  answer-side score-floor experiment (LEDGER: floor 0.4 over-abstained content, open-domain
  collapsed) — that gate decided whether to *abstain the whole answer*; this gate only decides
  whether to *add enrichment text* to one already-included hit, and a gated-out hit still flows to
  the answerer in its current, already-abstention-preserving plain form. Needs its own threshold
  sweep (same methodology as the rejected floor sweep, but a different decision variable) —
  genuinely untested, flag as the actual experiment, not a foregone conclusion.
- **(b) Prompt-side guardrail (cheap, pairs with a).** One additive instruction line in the (locked,
  cheap, frozen — `eval-cheap-stack-only`) answerer prompt: linked/adjacent context is
  supplementary, not itself evidence the question was answered — only use it if it directly
  contains the fact asked for. Must be A/B'd exactly like every other prompt change on this repo
  (single-variable, `--runs 3`, per the prior session's own standing methodology note) — do not
  ship untested on the strength of intuition alone.

This reframes the originating ask's "no cheap gate has delivered this yet" — the prior gates
(rerank score-floor, LLM-rerank abstain) all tried to gate the FINAL ANSWER post-hoc, after
ranking had already surfaced a wrong atom into a position of influence. Gating *enrichment* on an
otherwise-unchanged selection is a smaller, more local decision, and is the one degree of freedom
this feature introduces that didn't exist before — it is the crux experiment for this track, not a
formality.

### 2.5 Config + governance (do not repeat the FEAT-482/hardening-gap class of incident)

New `evidenceBundle` config block, OFF by default, additive — same posture as `crossEncoder`/
`multiHop`/`queryRewrite`:

```
evidenceBundle: {
  enabled: boolean;                 // default false
  maxAdjacentTurns: number;         // e.g. 1 (±1) — bounds turn-expansion fan-out
  maxLinkedAtoms: number;           // e.g. 2 — bounds graph-expansion fan-out per anchor
  maxBundleTokens: number;          // hard cap fed to the local rerank truncation step
  minAnchorScoreToBundle: number;   // implements 2.4(a)'s confidence gate
  timeoutMs: number;                // whole-bundle-assembly budget; degrades to no-bundle on breach
}
```

`retrieval-enable-needs-hardening` (2026-07-23 QA) found that the EXISTING `multiHop`/`crossEncoder`
flags shipped with unchecked numeric config fields (`maxSubQueries`/`timeoutMs`/`batchSize`, one of
which — a fractional `batchSize` floored to 0 — causes a timeout-immune infinite loop) precisely
because those bounds were validated only for enums, not magnitudes, at ship time. This new surface
must not repeat that: every numeric field above needs governance validation
(`applyEvidenceBundleGovernance`, same pattern as `applyMultiHopGovernance`/
`applyQueryRewriteGovernance`) landed in the SAME change that introduces the flag, not deferred to
a follow-up hardening pass. Given `maxLinkedAtoms`/`maxAdjacentTurns` fan out into *N further SQLite
reads per top-K hit*, the wall-clock risk is structurally the same shape as the fan-out gap already
flagged for decompose/rewrite (`search.ts::search`'s sequential sub-query gathering, no aggregate
timeout) — budget the WHOLE bundling pass (`timeoutMs` above), not just each read.

### 2.6 Interaction with Track I

Bundling's graph/temporal expansion (2.3 steps 3-4) pulls genuinely separate `memories` rows into
the response — but, per 2.3's core design choice, ONLY as enrichment attached to an already-selected
anchor, never merged back into a ranking/fusion pool. It therefore does not reopen Track I's
pool-tax risk *by this design* — but that guarantee is only as good as the enforcement that bundle
atoms never re-enter `fuseHits`/rerank's candidate list. Call this out explicitly in review: any
future change that lets a bundle-linked atom also compete for its own top-K slot (e.g. "since we
already fetched it, why not rank it too") would silently reintroduce exactly the failure mode Track
I fixes. Track I should land first regardless, since it's cheaper and independently valuable, and
because 1.5's arm (4) is the cleanest signal available today for whether the reranker's currently-
measured adversarial break is a pool-normalization artifact or a genuine ranking-quality problem —
that answer changes how urgently 2.4's confidence gate needs to be tuned (a normalization-fixed
reranker that stops breaking abstention on its own reduces how much weight the bundle gate has to
carry alone).

---

## 3. Sequencing, dependencies, expected deltas, risks

### 3.1 Build order

```
Track E (measurement overhaul: full-suite / ≥3-run median dev loop)  ── prerequisite for TRUSTING
        │                                                                any delta below noise
        ├──► Track I (fuse robust-norm)                [can start same-store NOW, parallel to
        │        1. red regression test (1.4)            Track E landing — no re-ingest, so immune
        │        2. winsorized implementation             to extraction noise; only needs Track E's
        │        3. same-store A/B matrix (1.5)           full-suite confirm before "ship it" sign-off]
        │        4. keep/revert decision
        │
        └──► #6 storage-read wiring (2.2-2.3)           [independent files: new src/search/
                 (build in parallel with Track I —        evidence-bundle.ts; does not touch fuse.ts
                  disjoint files, no shared ownership)     or search.ts's ranking path — only the
                       │                                   post-selection enrichment seam]
                       ▼
             #6 same-store A/B: bundling on/off
             × confidence-gate on/off × prompt-guardrail on/off
             (small factorial, cheap stack, 329-atom store)
                       │
                       ▼
             Gate: ADR-005 floors + adversarial must not regress
             below the current rerank-off 0.872 reference
                       │
                       ▼
             Full-suite (n=1986) reconfirm, cheap stack, ≥3 runs
             (existing plan's Gate C posture) before any enable-default
```

Track I and #6's storage-read wiring can build in parallel (disjoint files: `fuse.ts`+its three
call sites vs. a new `evidence-bundle.ts` + a narrow post-rerank hook in `search.ts` that does not
touch the fusion/rerank code Track I edits) — same disjoint-ownership discipline the 2026-07-20
Wave-1 worktree split used. The two A/B measurement passes should NOT run concurrently against the
same store session, since both mutate/re-run the harness's answer step and would confound each
other's noise band.

### 3.2 Expected deltas — stated on the SAME scale they'll be measured on

- **Track I**: unmeasured — genuinely "measure, don't predict." The one anchor available: if arm
  (4) in 1.5 recovers adversarial materially toward 0.872, the ceiling is bounded by the already-
  measured `onnx+abstain CEILING (sim)` row (+0.019 token-F1 over rerank-off, the perfect-routing
  upper bound for "rerank without breaking abstention") — Track I cannot exceed that on this store
  by definition, since perfect routing is its own ceiling regardless of mechanism.
- **#6 bundling**: the "+0.05–0.12 beyond the 0.75 ceiling" figure in the 2026-07-20 plan and
  performance-redesign handoff is measured on the **gpt-5.4-reader + CoT-judge** scale (where
  gold-turns ceiling = 0.750), NOT the cheap gpt-5-mini + token-F1 scale the dev loop actually
  iterates on (`eval-cheap-stack-only` — CoT is operator-gated, on-request only). Do not quote that
  number as a token-F1 expectation; there is no cheap-stack empirical ceiling for bundling yet
  because nothing has tested it on that ruler. Expect a smaller, TBD delta on token-F1 during
  iteration, and reserve the +0.05–0.12 framing strictly for an operator-approved CoT confirmation
  pass at a milestone gate — conflating the two scales is the exact mistake the LEDGER's own
  measurement rules (rule 2, "do not compare across scales") already exist to prevent.

### 3.3 Risks

- **Answerer-bound ceiling.** gpt-5-mini is locked (operator decision); bundling adds more context
  text into an already-constrained prompt budget — `maxBundleTokens` (2.5) is not optional
  polish, it's the guard against drowning the answerer, a token-level restatement of the same
  "broaden and tax" risk this whole design otherwise avoids at the ranking level.
- **Abstention breakage** — the crux risk (2.4), genuinely untested, not a foregone conclusion.
- **Noise floor** — same-store answerer nondeterminism ±0.008 overall / ±0.02 on n=32-sized
  category slices (multi-hop); any single-run delta smaller than that needs replication before
  trusting it, per the pattern already burned twice this month (multihop-mock run1 vs run2).
- **Hardening debt carried forward** — a brand-new config surface (`evidenceBundle`) must ship with
  governance validation from the same commit, not retrofitted after an incident, per
  `retrieval-enable-needs-hardening`'s own finding against the existing flags.
- **Turn-index scope assumption** (2.2) — flagged, not yet independently re-verified against
  `08-embed-index.ts`'s exact `EmbedIndexContext` wiring; a quick confirmation is cheaper than
  discovering a chunk-boundary mismatch mid-build.
- **Multiple transcript rows per session** — must key transcript lookup on `source_hash`, not
  `session_id` alone, or a re-ingested session could reconstruct turns against the wrong content.

## 4. Recommendation

Run Track I first (cheap, fast, same-store, no re-ingest, directly informs how hard #6's abstention
gate needs to work). Build #6's storage-read wiring in parallel since it touches disjoint files.
Do not enable either by default until: ADR-005 floors hold, the adversarial category is not below
its current 0.872 reference, and a full-suite (n=1986) reconfirm has run per the existing plan's
Gate C discipline. Do not quote #6's CoT-scale ceiling estimate as a token-F1 expectation.
