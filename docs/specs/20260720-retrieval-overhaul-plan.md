# Retrieval Overhaul Plan — LoCoMo 0.57 → 0.80+ (2026-07-20)

Incorporates both Codex architecture reviews (`docs/research/20260720-codex-architecture-reviews.md`)
and the oracle-factorial measured findings (`docs/eval-runs/20260720-oracle-factorial/README.md`).

## Honest target (do not overclaim)

| milestone | how | ceiling |
|---|---|---|
| **0.68–0.75** | fix retrieval bugs + hybrid RRF + local reranker + multi-query | the perfect-evidence ceiling (0.750) — pure retrieval quality |
| **0.80–0.86** | chained 2-hop + provenance-backed multi-scope evidence (beats the single-cited-turn ceiling) | requires new evidence representation |
| **0.90** | NOT currently evidenced. Do not commit to it until the oracle's perfect-evidence rung itself clears 0.90. | — |

Both models agree: 0.90 is fiction until proven. Ship 0.80–0.86 first, re-measure the ceiling, then decide.

## Measurement protocol (READ FIRST)

- **Dev A/B (every slice): token-F1 (deterministic, zero-LLM, zero-cost) is the PRIMARY signal**, plus the
  cheap gpt-5-mini llm-judge as a secondary. Deterministic token-F1 is ideal for *relative* deltas — no
  variance, no cost, run it as often as you like.
- **CoT judge (gpt-5.4) is DISABLED for dev iteration** (operator decision 2026-07-20 — too expensive to run
  per slice). It stays the *fair absolute* grader and is **re-enabled at phase-gate milestones only**, via the
  standalone `scripts/eval/locomo/oracle/rejudge.mts` (no code change needed to toggle — just don't run it
  mid-iteration; run it at gates).
- Every A/B: **same store, same conversation (conv-26, n=152), same day** (±6-pt service variance). Reconfirm at
  full-suite (n=1986) only at major milestones.
- A change is KEPT only if token-F1 shows a clear positive delta beyond same-day noise; milestone CoT re-judge
  confirms the absolute number before publishing.

## Phase 0 — Correctness prerequisites (BLOCKS everything; these are bugs)

These are not perf tuning — they are bugs that make downstream tuning invalid. Do first, no A/B needed beyond
"the knob now has an effect".

- **P0.1 — Config no-op.** `src/server/routes/search.ts:174` ignores the passed config and rebuilds
  `defaultConfig()` for fusion weights → retrieval tuning silently no-ops. Fix: thread the real runtime config.
  **Until this lands, every past retrieval A/B is suspect and every future one is meaningless.**
- **P0.2 — Crippled FTS.** `escapeFtsQuery` (`src/search/search.ts:372`) turns every question token into an
  implicit AND; stopwords zero-out most matches. Fix: analyzed lexical query — keep names/nouns/dates/numbers/
  quoted phrases, drop interrogatives/stopwords, boosted phrases + OR terms. This is the single cheapest win.
- **P0.3 — Eval exercises the real path.** `scripts/eval/locomo/oracle/sources/retrieved-atoms.mts` (and the
  real `run.mts` recall) send no `mode`/`expand`/rerank options, so the benchmark ran a near-dense-only path.
  Make the eval call the real hybrid `/recall` with the shipped defaults, so we measure what the product does.

## Phase 1 — Hybrid retrieval + RRF fusion  (Codex step 1; +0.03–0.07)

- Replace per-pool **min-max** fusion (`src/search/fuse.ts:117/189`, mixes relevance with freshness/importance/
  usefulness → unstable) with **weighted Reciprocal-Rank Fusion**. Relevance-first; metadata priors become small
  tie-breakers, not rank-drivers.
- ~75 lexical + 75 dense candidates → fuse → keep 40–60 for downstream. Do NOT raise answer-context `k=15`.
- Move duplicated FTS SQL into `MemoryRepo.searchFts()` (`src/storage/memories.ts:339`) with its own candidate depth.
- Local-first: deterministic SQLite only. **A/B: token-F1.**

## Phase 2 — Local cross-encoder reranker  (Codex step 2; +0.02–0.05)

- Plumbing exists (`src/search/rerank.ts`) but off; mock is Jaccard; real needs an HTTP sidecar.
- Run a compact BGE/mxbai reranker via a **localhost TEI/ONNX sidecar**; rerank the top 40–60 hybrid candidates → return 15.
- Fix the unrealistic 300 ms CPU timeout (`config.ts:1492`); record p50/p95 separately for CPU vs GPU.
- Rerank `query + atom text + evidence excerpt`, not atom text alone.
- Local-first: yes (localhost ONNX/TEI, no cloud). **A/B: token-F1.** Note: a reranker cannot recover evidence
  absent from the candidate pool — Phase 1 must land first.

## Phase 3 — Retrieval-oriented multi-query  (Codex step 3; +0.02–0.04)

- Replace the disabled generic rewrite (`src/search/query-rewrite.ts`) with 2–3 **targeted** variants:
  entity/name form, lexical-fact form, temporal form.
- Deterministic-first (extract entities/aliases from the query + the stored `entities` table); invoke a small
  **local Ollama** model only when rules yield nothing. Never silently reuse a cloud extraction provider on the hot path.
- Merge original + variants with **RRF**, rewarding atoms retrieved by multiple variants. Auto-enable only for
  low-confidence initial retrieval.
- Directly attacks the measured query-side miss (PRF failed because it expanded from already-wrong hits). **A/B: token-F1.**

## Phase 4 — Chained two-hop retrieval  (Codex step 4; multi-hop +0.15–0.30 cat ≈ +0.03–0.06 overall)

Depends on Phase 6 having populated the entity graph.
- Current `decompose.ts` searches subqueries independently — never chains. Implement real chaining:
  1. retrieve hop-1 candidates → 2. load their `memory_entities` → 3. pick ≤2 non-generic bridge entities
  (by hit rank, query mention, entity frequency) → 4. fetch memories linked to those entities (NOT required to
  also match the original query) → 5. traverse one `entity_relations` edge → 6. rerank two-atom chains, flatten
  best into the 15-item budget.
- Remove/greatly reduce `supplementalWeight=0.5` (`src/search/search.ts:724`) — it buries the evidence this
  stage exists to recover.
- Local-first: SQLite graph traversal + optional small Ollama classifier. **A/B: token-F1, per-category multi-hop.**

## Phase 5 — Provenance-backed multi-scope evidence  (Codex step 5; +0.05–0.12; the ONLY path past 0.75)

Required for 0.80+. Ranking existing atoms better cannot cross the 0.750 gold-atom ceiling.
- Persist structured per-atom provenance at extraction: transcript/session ID, turn ID, char offsets, exact
  evidence span (`src/distill/stages/05-extract.ts:132`, `pipeline.ts:635`, persist in `memories.ts:22`). Today
  only an optional evidence string is stored and recall omits it — the eval's fuzzy back-map proved 25% match, insufficient.
- After direct retrieval, build an **evidence bundle**: the atom + its exact source turn + ±1 adjacent turns +
  bridge-entity-linked turns + temporally-adjacent events (temporal Qs). Locally rerank spans/chains under ONE
  shared token budget. Do NOT blindly append neighbors (PRF already rejected that).
- Return bundle provenance through `/recall`; teach the local answerer to consume grouped chains, not an
  unordered atom list.
- Local-first: entirely local. **A/B: token-F1 + full-suite; CoT re-judge at the gate — this is the milestone that must clear 0.80.**

## Phase 6 — Graph population  (Codex step 6; +0.02–0.05; PREREQ for Phase 4/5)

- The conversational extract prompt (`src/distill/prompts/extract.ts:343`) does NOT request `relations[]` despite
  the schema supporting it → the graph is nearly empty. Add relation extraction.
- After reduce (`pipeline.ts:635`), deterministically link atoms sharing normalized entities / session proximity /
  possession-family relations / explicit event participants. Narrow offline enrichment for unresolved relation-bearing
  atoms only. Require provenance for every generated edge.
- Build order note: this POPULATES the graph that Phase 4 consumes and Phase 5 bundles — schedule its build before
  Phase 4's A/B even though Codex numbered it 6.

## Phase 7 — Atom triage (deprioritized; +0.00–0.01)

- Enable `repair-only` (retain every atom, apply corrected type, store support judgment). NEVER enable dropping.
- `config.ts:1641`. Low priority — only worth it if `type` ever participates in retrieval.

## Dependency order (build sequence)

```
P0 (bugs) ──► P1 (hybrid+RRF) ──► P2 (rerank) ──► P3 (multi-query)      [reaches ~0.68–0.75]
                                     │
P6 (graph populate) ────────────────┴──► P4 (chained 2-hop) ──► P5 (provenance multi-scope)  [reaches ~0.80–0.86]
                                                                     └─ P7 (triage, anytime, low pri)
```

## Milestone gates (where CoT judge turns back ON)

- **Gate A (after P1–P3):** token-F1 must show clear cumulative gain; run gpt-5.4 CoT re-judge + full-suite once →
  expect ~0.68–0.75. If not, stop and re-diagnose before P4.
- **Gate B (after P4+P6):** multi-hop category must move materially; CoT re-judge.
- **Gate C (after P5):** the 0.80 milestone. Full-suite, ≥3 runs, CoT judge, conversation-level splits. Only here is
  a "0.80+" number claimable, per the eval-runs measurement rules.

## Slice breakdown (for the loop backlog)

P0.1, P0.2, P0.3 (three small slices) · P1 (1 slice) · P2 (1 slice) · P3 (1 slice) · P6 (1–2 slices) ·
P4 (1 slice) · P5 (2–3 slices) · P7 (1 slice, deferred). Each slice: implement → token-F1 A/B → reviewer →
keep-or-revert. CoT re-judge only at Gates A/B/C.
