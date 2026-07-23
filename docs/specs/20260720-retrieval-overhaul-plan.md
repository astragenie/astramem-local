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

## Measurement protocol (READ FIRST) — LOCKED to the OLD baseline recipe

The whole point of dev A/B is "did this fix improve the **old baseline**?" So the dev recipe is the historical
cheap recipe, byte-comparable to the numbers already in the LEDGER — NOT the gpt-5.4 diagnostic stack.

- **Answerer = gpt-5-mini, reasoning minimal** — the FROZEN benchmark answerer (`run.mts` / oracle `current`).
  Revert from the diagnostic gpt-5.4 reader. This keeps every A/B comparable to baseline-v2 and the whole LEDGER.
- **Judge (dev) = token-F1 (deterministic, zero-LLM, zero-cost) PRIMARY + gpt-5-mini llm-judge secondary.**
  token-F1 has no cost and no variance — ideal for *relative* deltas.
- **gpt-5.4 reader AND gpt-5.4 CoT judge are BOTH diagnostic-only, OPERATOR-GATED tools** (operator decision
  2026-07-20, REAFFIRMED + TIGHTENED 2026-07-20). They do NOT run during iteration **AND do NOT auto-run at
  phase gates.** Every measurement — dev iteration AND every milestone gate (A/B/C) — uses the cheap stack:
  gpt-5-mini `current` answerer + gpt-5-mini llm-judge (+ token-F1). The gpt-5.4 reader (`zep-match` answerer)
  and CoT re-judge (`rejudge.mts`) fire ONLY when the operator explicitly approves the switch, run by run.
  No code toggle, no automatic gate trigger — just don't run them until told.
- **The number to beat:** baseline-v2 on the SAME store — conv-26, cat1-4, gpt-5-mini answerer. token-F1
  cat-avg ≈ 0.39 / gpt-5-mini-llm-judge cat-avg ≈ 0.461 (`docs/eval-runs/LEDGER.md` P0a rescore). Every fix
  must beat THAT under the identical cheap recipe.
- Every A/B: **same store, same conversation (conv-26, n=152), same day** (±6-pt service variance). Full-suite
  (n=1986) reconfirm only at major milestones.
- A change is KEPT only if token-F1 shows a clear positive delta beyond same-day noise. Gate stages are scored
  on the SAME cheap recipe (gpt-5-mini answerer + gpt-5-mini llm-judge + token-F1) — they do NOT auto-add the
  gpt-5.4 reader / CoT judge. The fair-absolute gpt-5.4+CoT read is an operator-approved, on-request pass only.

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
- Local-first: entirely local. **A/B: token-F1 + gpt-5-mini llm-judge + full-suite (cheap stack) — this is the milestone that must clear 0.80 on the cheap ruler; gpt-5.4+CoT confirmation is operator-approved only.**

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

## Milestone gates (ALL scored on the cheap stack — CoT stays OFF until operator approves)

Operator instruction 2026-07-20: gates are measured with the SAME cheap recipe as dev iteration —
gpt-5-mini `current` answerer + gpt-5-mini llm-judge + token-F1. The gpt-5.4 reader / CoT re-judge do
NOT auto-fire here; the operator approves that switch run-by-run when a fair-absolute read is wanted.

- **Gate A (after P1–P3):** token-F1 + gpt-5-mini llm-judge must show clear cumulative gain over the
  baseline-v2 cheap numbers (token-F1 ≈ 0.39 / llm-judge ≈ 0.461); full-suite reconfirm once. If no clear
  gain, stop and re-diagnose before P4. (Fair-absolute gpt-5.4+CoT read: only if operator approves.)
- **Gate B (after P4+P6):** multi-hop category must move materially under the cheap stack.
- **Gate C (after P5):** the 0.80 milestone. Full-suite, ≥3 runs, cheap stack, conversation-level splits. A
  "0.80+" claim on the cheap ruler is what's tracked here; the fair-absolute gpt-5.4+CoT confirmation is an
  operator-approved pass, not automatic.

## Slice breakdown (for the loop backlog)

P0.1, P0.2, P0.3 (three small slices) · P1 (1 slice) · P2 (1 slice) · P3 (1 slice) · P6 (1–2 slices) ·
P4 (1 slice) · P5 (2–3 slices) · P7 (1 slice, deferred). Each slice: implement → token-F1 A/B → reviewer →
keep-or-revert. gpt-5.4 reader / CoT re-judge: operator-approved only, never automatic.

---

# Parallel execution plan (isolated git worktrees)

`src/search/search.ts` is the hub every retrieval phase funnels through, so we parallelize by **disjoint
subsystem**, not by phase. Good news from the Codex reviews: the plug points ALREADY EXIST in the orchestrator
(`rerank()` at ~`search.ts:1109`, rewrite at ~`:759`, decompose at ~`:724`) — so the reranker and query-rewrite
tracks implement *behind existing hooks* and never touch `search.ts`. Only the retrieval-core track owns it.

## Wave 0 — serial trunk (ONE owner, ~half a day). Everyone branches from this commit.

Coordination commit. Nothing parallel can start until it lands, because it fixes the bugs that make A/B valid
AND locks the measurement harness every track shares.
- **P0.1** config no-op fix (`src/server/routes/search.ts:174`) — thread the real runtime config into fusion.
- **P0.2** FTS fix (`src/search/search.ts:372` `escapeFtsQuery`) — analyzed lexical query, drop stopwords/interrogatives.
- **P0.3 + harness**: eval calls the real hybrid `/recall`; land a one-command **token-F1 A/B runner** pinned to
  the CHEAP recipe (gpt-5-mini answerer, token-F1 + gpt-5-mini llm-judge, conv-26 n=152) that every worktree runs
  identically. Capture the baseline-v2 number as the bar.
- Confirm the existing `rerank`/`rewrite`/`decompose` hook points compile as no-op seams so Wave-1 tracks plug in
  without editing `search.ts` (except the core track).

## Wave 1 — three parallel worktrees (disjoint files, ~simultaneous)

| worktree | owns (files) | phases | touches search.ts? |
|---|---|---|---|
| **WT-A retrieval-core** | `src/search/fuse.ts`, `src/search/query-rewrite.ts`, `src/search/search.ts` | P1 (RRF fusion) + P3 (multi-query) | YES — sole owner |
| **WT-B reranker** | `src/search/rerank.ts`, reranker sidecar, `src/config/config.ts` rerank defaults | P2 (local cross-encoder) | NO — behind the `:1109` hook |
| **WT-C distill-graph** | `src/distill/prompts/extract.ts`, `src/distill/pipeline.ts`, `src/distill/stages/05-extract.ts`, `src/storage/memories.ts`, `src/storage/entity-relations.ts` | P6 (relations + cross-atom links) + P5-storage (provenance persistence) | NO — src/distill + src/storage only |

No two worktrees share a file. WT-B/WT-C never edit `search.ts`; WT-A never edits `src/distill`/`rerank.ts`.
`config.ts` is touched only by WT-B (rerank defaults) — if WT-A also needs a fusion-weight default, put it in a
separate config sub-key or land it in Wave 0 to avoid the one shared file.

### Per-worktree A/B without daemon-lock contention
Retrieval A/B is **read-only** on the store, but concurrent daemons on one datadir hit the instance lock (learned
in the oracle build). So each store-needing worktree **copies** `.eval-data/locomo/runs/20260720-baseline-v2/datadir`
to its own path and mounts its daemon there. A copy is cheap and fully isolates the lock. WT-C's distill changes
need a *re-ingest* to take effect (they change what's stored) — WT-C runs a small scoped re-ingest into its own
datadir for its A/B; WT-A/WT-B reuse the baseline store as-is (they only change retrieval, not storage).

## Wave 2 — serial integration (after Wave 1 merges + graph is populated)

These consume multiple subsystems, so they can't parallelize:
- **P4 chained 2-hop** (`search.ts:724` decompose) — consumes WT-C's populated entity graph + WT-A's core. Owner: retrieval-core.
- **P5 multi-scope bundling** (`search.ts` + local answerer) — consumes WT-C's provenance + WT-A's core. Owner: retrieval-core.
Run these in one worktree, serially, each with its own token-F1 A/B.

## Merge + gate order

```
Wave 0 (trunk: bugs + harness + seams)  ──►  merge to feat branch
   ├─ WT-A (P1+P3)  ─┐
   ├─ WT-B (P2)     ─┼─►  merge all 3 (disjoint files, clean)  ──►  GATE A: cheap-recipe token-F1 + gpt-5-mini
   └─ WT-C (P6+P5a) ─┘                                              llm-judge must beat baseline. gpt-5.4+CoT read:
                                                                    operator-approved only (not automatic).
   Wave 2: P4 ──► P6-graph must be populated first ──► P5  ──►  GATE C: full-suite, ≥3 runs, cheap stack (0.80 milestone)
```

## Dispatch shape
Wave 0 = 1 synchronous builder (it's the shared trunk — get it right, review, commit). Wave 1 = 3 background
`crew:fullstack-dev` builders in `isolation: worktree` off the Wave-0 commit, awaitAll, review each, merge disjoint.
Wave 2 = sequential builders in one worktree. Same pattern as the oracle-factorial parallel build that worked today.
