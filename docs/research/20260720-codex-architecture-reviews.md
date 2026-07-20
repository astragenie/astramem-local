# Codex architecture reviews — LoCoMo retrieval (2026-07-20)

Two independent Codex (gpt-5-codex, high reasoning) reviews of the astramem-local
retrieval/memory architecture, prompted with the oracle-factorial measured findings
(fair pipeline 0.566, perfect-evidence ceiling 0.750, retrieval is the bottleneck,
PRF failed = query-side misses). Presented verbatim. Tokens: ~174k (review 1).

---

## Review 1 — Gaps + redesign-from-scratch (in existing architecture)

Bottom line: this is an atom-level search engine with several SOTA-shaped seams, mostly disabled or ineffective. It is not a temporal multi-scope memory system.

One correction: the current tree is not literally dense-only. [`search.ts`](C:/work/mega/astramem-local/src/search/search.ts:589) gathers FTS5 BM25 and vectors, and `/recall` defaults to `hybrid`. But natural-language FTS is crippled: [`escapeFtsQuery`](C:/work/mega/astramem-local/src/search/search.ts:372) turns every question token into an implicit AND. Stopwords alone will eliminate most matches. The benchmark sends no `mode`, `expand`, or rerank options in [`retrieved-atoms.mts`](C:/work/mega/astramem-local/scripts/eval/locomo/oracle/sources/retrieved-atoms.mts:35), so it is effectively one-shot dense retrieval with a mostly-empty lexical leg.

## 1. Structural gaps

- **No real query understanding.** [`search.ts`](C:/work/mega/astramem-local/src/search/search.ts:693) embeds the raw question directly. It does not extract entities, aliases, time constraints, relation predicates, answer type, or discriminative noun phrases. [`query-rewrite.ts`](C:/work/mega/astramem-local/src/search/query-rewrite.ts:17) exists but is config-off, request-opt-in, and either LLM-backed or a trivial mock. This matches the measured query-side failure.

- **Weak hybrid retrieval, not Mem0-style hybrid retrieval.** BM25 uses all-token AND; fusion in [`fuse.ts`](C:/work/mega/astramem-local/src/search/fuse.ts:189) min-max normalizes each candidate pool and mixes relevance with freshness, importance, and usefulness. That is unstable across queries and can let metadata priors outrank relevance. There is no RRF, calibrated sparse/dense fusion, minimum-should-match, field weighting, stemming, aliases, or phrase/entity retrieval.

- **No usable local reranker.** [`rerank.ts`](C:/work/mega/astramem-local/src/search/rerank.ts:252) is off by default. The “mock” is Jaccard overlap; the real provider requires an HTTP sidecar. There is no in-process ONNX cross-encoder. More importantly, reranking cannot recover gold evidence absent from the candidate pool.

- **Single representation scope.** Stage 8 embeds only `normalizedText` once in [`08-embed-index.ts`](C:/work/mega/astramem-local/src/distill/stages/08-embed-index.ts:221). Search retrieves only atoms. Raw `messages` and `transcripts` exist in migration 001 but are never retrieval scopes. There are no episode summaries, turn spans, event clusters, or multi-vector representations for claim/evidence/entities.

- **Graph is write-only for recall.** [`entity-relations.ts`](C:/work/mega/astramem-local/src/storage/entity-relations.ts:88) provides storage/lookups, but [`search.ts`](C:/work/mega/astramem-local/src/search/search.ts:678) never imports or traverses it. Entity support is an explicit filter or disabled bonus over already-found candidates—not candidate generation. Worse, the conversational extraction prompt in [`extract.ts`](C:/work/mega/astramem-local/src/distill/prompts/extract.ts:343) does not request `relations[]`, despite the schema supporting them. LoCoMo therefore gets little graph material.

- **“Multi-hop” is not chained retrieval.** [`decompose.ts`](C:/work/mega/astramem-local/src/search/decompose.ts:2) independently searches static subqueries and merges them. It never resolves hop one—“who gave the painting?”—then substitutes that entity into hop two. It is also off by default.

- **Temporal retrieval requires caller-supplied structure.** `as_of` works when explicitly provided, but the query is never parsed for “before,” “after,” “when,” or historical state. Generic 30-day freshness decay can actively damage historical questions.

- **Filters are applied too late.** Project, scope, type, agent, and validity are applied after the fixed global candidate window in [`search.ts`](C:/work/mega/astramem-local/src/search/search.ts:873). [`sqlite-vec.ts`](C:/work/mega/astramem-local/src/vector/sqlite-vec.ts:25) explicitly lacks prefiltering. A top-50 global search can miss an item that is top-1 inside the requested project.

- **Configuration bug.** [`server/routes/search.ts`](C:/work/mega/astramem-local/src/server/routes/search.ts:174) ignores the passed config for fusion weights and uses a fresh `defaultConfig()`. Retrieval tuning can silently have no effect.

## 2. Redesign

In priority order:

1. **Query planner in `src/search/query-plan.ts`.** Deterministically extract named entities, aliases, dates, relation cues, answer type, and high-information terms. Generate 3–6 focused variants. Optional local LLM enhancement; never mandatory cloud.

2. **Replace `gatherCandidates` with parallel scoped retrievers.**
   - FTS5 BM25 using OR/minimum-should-match, stemming, phrases, and weighted fields.
   - Dense search for original and expanded queries.
   - Entity/alias lookup producing candidates directly.
   - Push project/scope/type/validity constraints into each retriever.
   - Fuse ranked lists with weighted RRF, not per-pool min-max scores.

3. **Local ONNX cross-encoder.** Rerank roughly 50–100 union candidates using a small MS MARCO/BGE reranker. Keep HTTP as optional acceleration, not the only real implementation.

4. **Multi-scope memory representation.**
   - Atomic semantic facts.
   - Episodic session/turn chunks with source offsets.
   - Entities and aliases.
   - Temporal relation edges.
   - Separate embeddings for atom claim, evidence excerpt, and episode text.

5. **Actual graph retrieval.** Resolve query entities, traverse valid 1–2-hop edges, retrieve their evidence atoms/episodes, then run the next hop using resolved entity names. Fuse graph evidence as another ranked scope.

6. **Final packing.** Cross-encoder rank, deduplicate near-identical atoms, apply MMR/entity diversity, and return supporting episode spans alongside atoms.

## 3. Highest-leverage change

Replace one-shot raw-question retrieval with a **default-on query-planned multi-query sparse+dense candidate generator using RRF**.

Do this before graph work or reranking. Extraction is net-neutral, PRF failed because it expands from already-wrong hits, and a reranker cannot score candidates it never sees. The existing rewrite seam is insufficient: it is disabled, request-gated, model-dependent, and merges by incomparable per-query max scores.

This is the change most directly aligned with the measured 0.18 query-side loss. Even perfect retrieval only moves the current stack toward its measured 0.750 ceiling; it does not explain or validate Zep’s claimed 0.947.

---

## Review 2 — Organic path toward 0.90 (ordered, with deltas)

## Reality check

The checked-in code is not pure dense retrieval. It already runs FTS5 plus vectors by default, but the lexical leg is weak: every query token becomes an implicit `AND`, so natural-language questions frequently produce zero FTS hits. Rewrite, decomposition, and reranking also exist but ship disabled. The LoCoMo `/recall` path is in [routes/search.ts](C:/work/mega/astramem-local/src/server/routes/search.ts:273); [routes/recall.ts](C:/work/mega/astramem-local/src/server/routes/recall.ts:32) only implements `/recall/pack` and does not affect this benchmark.

Expected deltas below are absolute LoCoMo score, are not safely additive, and require the same n=152 A/B.

1. Fix lexical retrieval and fusion first

Change:

- Replace `escapeFtsQuery()`’s all-token `AND` query with analyzed lexical queries: retain names, nouns, dates, numbers, and quoted phrases; drop interrogatives/stopwords; use boosted phrases plus `OR` terms.
- Move the duplicated FTS SQL into `MemoryRepo.searchFts()` and support separate lexical candidate depth.
- Replace per-list min-max fusion with weighted reciprocal-rank fusion. Current independently normalized BM25/cosine scores are unstable and incomparable across query variants.
- Retrieve roughly 75 lexical + 75 dense candidates, fuse, then keep 40–60 for reranking. Do not increase answer-context `k=15`.

Files: [search.ts](C:/work/mega/astramem-local/src/search/search.ts:372), [fuse.ts](C:/work/mega/astramem-local/src/search/fuse.ts:117), [memories.ts](C:/work/mega/astramem-local/src/storage/memories.ts:339).

Expected: **+0.03–0.07**, primarily closing retrieval loss toward 0.75. If today’s measured daemon truly ran semantic-only, the upper end is plausible; if it already ran this nominal hybrid path, expect the lower end.

Local-first: deterministic SQLite only.

2. Activate a real local cross-encoder

The plumbing already exists, including top-K reranking and a localhost HTTP provider. The shipped provider is a Jaccard mock and the feature is off.

Change:

- Run a compact reranker such as a BGE/mxbai reranker through a localhost TEI-compatible sidecar.
- Rerank the top 40–60 hybrid candidates; return 15.
- Increase the 300 ms timeout for CPU deployments—300 ms is unrealistic without a warm GPU. Record p50/p95 separately for CPU and GPU.
- Rerank `query + atom text + evidence excerpt`, not atom text alone.

Files: [rerank.ts](C:/work/mega/astramem-local/src/search/rerank.ts:121), [search.ts](C:/work/mega/astramem-local/src/search/search.ts:1109), defaults in [config.ts](C:/work/mega/astramem-local/src/config/config.ts:1492).

Expected: **+0.02–0.05**, still below the 0.75 evidence ceiling. It reduces distractors; it cannot recover evidence absent from the candidate pool.

Local-first: yes, via localhost ONNX/TEI. No cloud requirement.

3. Replace generic rewrite with retrieval-oriented multi-query

Current rewrite is disabled, makes a hot-path LLM call, and merges independently normalized lists by maximum score. That lets arbitrary variant normalization dominate.

Change:

- Generate 2–3 targeted variants: entity/name form, lexical fact form, and temporal form.
- First use deterministic extraction from the query plus aliases already stored in `entities`; invoke a small Ollama model only when rules produce no useful variant.
- Merge original and variant rankings with RRF, rewarding an atom retrieved by multiple variants.
- Enable automatically only for low-confidence initial retrieval, not every query.

Files: [query-rewrite.ts](C:/work/mega/astramem-local/src/search/query-rewrite.ts:274), [search.ts](C:/work/mega/astramem-local/src/search/search.ts:759), [routes/search.ts](C:/work/mega/astramem-local/src/server/routes/search.ts:195).

Expected: **+0.02–0.04**, toward 0.75. PRF failed because it expanded from potentially wrong hits; query-side entity/alias variants attack the measured failure directly.

Local-first: deterministic or Ollama. Do not silently reuse a cloud-configured extraction provider.

4. Implement actual chained two-hop retrieval

Current “multi-hop” implementation retrieves all decomposed subqueries independently. It is not chained: hop two never learns the bridge entity discovered by hop one.

Change:

1. Retrieve hop-one candidates.
2. Load their `memory_entities`.
3. Select at most two non-generic bridge entities using hit rank, query mention, and entity frequency.
4. Directly fetch memories linked to those entities; do not require them also to match the original query.
5. Traverse one `entity_relations` edge where available.
6. Rerank complete two-atom chains against the question, then flatten the best chains into the 15-item evidence budget.

Remove or greatly reduce the current `supplementalWeight=0.5`; it systematically buries the evidence this stage exists to recover.

Files: [search.ts](C:/work/mega/astramem-local/src/search/search.ts:724), [decompose.ts](C:/work/mega/astramem-local/src/search/decompose.ts:220), entity storage modules under `src/storage/`.

Expected: multi-hop **+0.15–0.30 category score**, approximately **+0.03–0.06 overall**. Mostly closes the category’s gap from 0.406 toward its roughly 0.72 gold ceiling.

Local-first: SQLite graph traversal plus optional small Ollama classifier.

5. Add provenance-backed multi-scope evidence to beat 0.75

This is the required architectural step for 0.90. Exact gold turns score only 0.750; ranking existing atoms better cannot cross that ceiling.

Change:

- Persist structured source provenance per atom: transcript/session ID, turn ID, character offsets, and exact evidence span. Today `MemoryRepo` stores only an optional evidence string, and recall omits it.
- After direct retrieval, construct an evidence bundle containing:

  - the atom;
  - its exact source turn;
  - adjacent ±1 turns;
  - other turns/atoms linked through the bridge entity;
  - temporally adjacent events when the question is temporal.

- Locally rerank spans/chains and enforce one shared token budget. Do not blindly append neighbors—the PRF experiment already rejected that.
- Return bundle provenance through `/recall` and teach the local answerer to consume grouped chains rather than an unordered atom list.

Files: extraction provenance in [05-extract.ts](C:/work/mega/astramem-local/src/distill/stages/05-extract.ts:132) and [pipeline.ts](C:/work/mega/astramem-local/src/distill/pipeline.ts:635); persistence in [memories.ts](C:/work/mega/astramem-local/src/storage/memories.ts:22); response assembly in [search.ts](C:/work/mega/astramem-local/src/search/search.ts:678) and [routes/search.ts](C:/work/mega/astramem-local/src/server/routes/search.ts:334). The eval prototype already demonstrates why fuzzy back-mapping is insufficient in [retrieved-spans.mts](C:/work/mega/astramem-local/scripts/eval/locomo/oracle/sources/retrieved-spans.mts:20).

Expected: **+0.05–0.12 beyond the atom-only system**. This is the first step capable of beating 0.75. Reaching 0.90 is not currently evidenced; target **0.80–0.86 first**. A local answerer makes 0.90 harder, not easier.

Local-first: entirely local storage, retrieval, reranking, and Ollama answering.

6. Add cross-atom links; do not spend first on more extraction

Relations currently must connect entities appearing inside the same atom. That is too narrow for conversational multi-hop evidence.

Change:

- After reduce, deterministically link atoms sharing normalized entities, session proximity, possession/family relations, or explicit event participants.
- Add a narrow offline enrichment pass only for unresolved relation-bearing atoms.
- Require provenance for every generated edge.

Files: [extract prompt/schema](C:/work/mega/astramem-local/src/distill/prompts/extract.ts:37), relation guard in [05-extract.ts](C:/work/mega/astramem-local/src/distill/stages/05-extract.ts:481), insertion point after reduce in [pipeline.ts](C:/work/mega/astramem-local/src/distill/pipeline.ts:635).

Expected: **+0.02–0.05 overall**, but only after step 4 consumes the graph.

Local-first: rules plus local model; a strong offline extractor is acceptable, but no cloud dependency in recall.

7. Enable atom triage only in `repair-only`

Measured recall 78→80.1 and type accuracy +9 do not justify discard mode. Type correction barely matters unless type participates in retrieval.

Change: evaluate `repair-only`; retain every atom, apply corrected type, store support judgment. Do not enable dropping.

Files: [pipeline.ts](C:/work/mega/astramem-local/src/distill/pipeline.ts:724), default in [config.ts](C:/work/mega/astramem-local/src/config/config.ts:1641).

Expected: **0.00–0.01 LoCoMo**. Low priority.

The credible sequence is **0.57 → roughly 0.68–0.75 through retrieval/reranking**, then **0.80–0.86 through chained, provenance-backed multi-scope evidence**. Claiming 0.90 before that oracle passes 0.90 would be fiction.
