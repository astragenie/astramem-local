---
review: retrieval-core-and-fusion-adversarial-qa
scope: src/search/search.ts, src/search/fuse.ts, src/search/presets.ts, src/server/routes/search.ts, src/server/routes/recall.ts, tests/eval/retrieval-eval.test.ts
mode: read-only investigation + targeted repro (no source edits)
date: 2026-07-23
---

# Adversarial QA — retrieval core + fusion

Goal was to break the existing hybrid-search/fusion path: silent-wrong-results and
hangs. Five landmines were probed per the brief; two produced real findings, three
came back closed. One additional class of bug (route/tool `mode` wiring) was found
outside the five landmines while auditing config-knob consumption per item #1.

No source files were edited. One temporary repro test
(`tests/search/zz-repro-pool-tax.test.ts`) was created, run, and deleted before
finishing — it is not present in the working tree.

## Findings (most severe first)

| # | Location | Severity | Break-case → observed vs expected | Repro | Confidence |
|---|----------|----------|-------------------------------------|-------|------------|
| 1 | `src/search/fuse.ts::normalizeScores` / `fuseHits` | 🔴 SILENT-WRONG | One irrelevant candidate with an extreme (unbounded) raw BM25 magnitude entering the candidate pool inverts the relative ranking of two OTHER unrelated candidates whose own raw signals never changed. Expected: adding an irrelevant low-importance candidate should never demote a correct top-1 result below a weaker one. Observed: it does, silently, with no error and no signal to the caller. | Reproduced live via `fuseHits()` (see script below) — baseline `{A: 0.56, B: 0.55}` (A wins) flips to `{B: 0.55, C: 0.51, A: 0.19}` (B wins) purely by adding junk candidate C; A's/B's own bm25/importance/freshness inputs were untouched between runs. | HIGH — reproduced |
| 2 | `src/server/routes/search.ts` (GET `/search` handler) + `src/mcp/server.ts` (`search_memory`, `recall_memory`) | 🔴 SILENT-WRONG (declared-not-wired, same class as the P0.1 precedent) | `SearchOpts.mode` (`keyword`\|`semantic`\|`hybrid`, FEAT-532 L2, part of the shared `astramem-retrieval-query@1` wire contract) is completely unreachable from 3 of the 4 access surfaces. GET `/search` has no `mode` query-param parsing at all (confirmed by grep — zero occurrences outside doc comments); neither MCP tool declares a `mode` field in its zod input schema; neither passes `mode` into `search()`'s opts. Only POST `/recall` actually wires it. A caller asking for `mode=keyword` (skip the vector leg) or `mode=semantic` (skip FTS) via GET `/search` or either MCP tool gets silently downgraded to `hybrid` with no error, no warning, and no wire-visible indication the request wasn't honored. | Static — grep `mode` across `src/server/routes/search.ts` (only appears in POST /recall's zod schema + handler) and `src/mcp/server.ts` (`search_memory`/`recall_memory` tool schemas have no `mode` field, and their `search()` calls omit `mode` from opts entirely). | HIGH — exhaustive grep, unambiguous absence |
| 3 | `src/search/search.ts` — debug branch (`opts.debug` block) vs `SearchDebugHit` | 🟡 SILENT-WRONG (debugging surface only) | `SearchDebugHit`'s doc comment promises `score` is exactly reconstructible from the reported `weights`/component fields. The debug branch's `rawWeightSum`/`effectiveWeights` are computed from only `alpha+beta+gamma+delta+epsilon+zeta` — **eta and theta are omitted entirely** — while the real `hit.score` (from `fuseHits`/`fuseScores`, used elsewhere in the same function) already folds `eta*agentBonus` and `theta*uncontestedBonus` into both the numerator and the weight-sum denominator. `SearchDebugHit`'s type doesn't even have `agentBonus`/`uncontestedBonus` fields, so the shape can't represent those contributions even if the math were fixed. Currently dormant: `eta`/`theta` are both forced to governed-zero by `applyFusionGovernance`'s eval-evidence gate in every config-loaded caller (recorded evidence table is empty for both per `src/eval/eval-evidence.ts`) — but any direct `search()` caller that hand-builds a weights object with `eta`/`theta` > 0 bypasses that gate entirely, which `fuse.ts`'s own doc comment explicitly sanctions as a normal calling pattern (tests already do this). The moment eta/theta evidence is ever recorded, every `debug:true` request becomes silently unreconstructable for boosted/flagged hits. | Static — direct comparison of two adjacent computations in the same file: the debug branch's `rawWeightSum` (search.ts, ~line 1125) vs the non-debug `explainWeightSumRaw` (~line 1185) a few dozen lines later, which correctly includes `+ eta + theta`. Not runtime-reproduced (would need eval-evidence bypass + a live DB) — the arithmetic gap is unambiguous from source alone. | HIGH (static), not runtime-reproduced |
| 4 | `src/server/routes/search.ts` — GET `/search` vs POST `/recall` | 🟡 protection-gap (not itself a hang) | POST `/recall` and POST `/memory/:id/used` both wrap their handler body in `withDeadline` (30s, clean 504 on a stuck async chain — e.g. a broken `AbortSignal` in an embed/rerank/decompose/query-rewrite call, exactly the class `withDeadline`'s own doc comment says it exists to catch). GET `/search` has no such wrapper at all — confirmed via grep, `withDeadline` is imported and used only inside the POST `/recall` handler in that file. The identical stuck-downstream-call scenario on GET `/search` has no protection short of Fastify's blanket 60s connection-level `requestTimeout`, and gets no diagnostic 504 body. | Static — grep confirms `withDeadline` usage is confined to POST `/recall` (and, in a sibling file, POST `/memory/:id/used`) in this router set. Not reproduced as an actual hang (would require deliberately breaking an AbortSignal wire to trigger). | HIGH (asymmetry itself), MEDIUM (real-world impact — requires another bug to actually manifest) |
| 5 | `src/search/decompose.ts::getSubQueries` + `src/search/query-rewrite.ts::getQueryVariants`, consumed from `src/search/search.ts`'s merge loops (~lines 877-890, ~910-916) | 🟢 latency-budget gap, not a hang | Both stages hard-timeout their own LLM call (`opts.timeoutMs`), but the subsequent per-subquery/per-variant `gatherCandidates()` fan-out is a **sequential** `for`+`await` loop with **no aggregate stage-level timeout** — only each individual `embed()` call is self-bounded (the Ollama provider's own `AbortSignal.timeout`, confirmed in `src/providers/embed/ollama.ts`). N subqueries × per-call embed timeout can multiply into total latency well beyond what the config's single `timeoutMs` field implies, with no caller-visible accounting for it. Not a genuine hang — each embed call the loop makes does eventually resolve or throw — but a real, unbounded-by-config latency multiplier that neither `resolveDecomposeOpts` nor `resolveQueryRewriteOpts`'s doc comments disclose. | Static — traced the sequential loop shape in `search.ts` and confirmed the embed provider's per-call timeout floor in `ollama.ts`; not timed against a live slow provider. | MEDIUM (static), not reproduced |

### Repro script for finding #1 (already run, file deleted after)

```ts
import { fuseHits } from '../../src/search/fuse.js';
const NOW = 1_700_000_000_000;
const weights = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

// Baseline: A (moderate bm25, no vec hit, importance 0.6) beats
// B (weak bm25, sole vec hit cosine=1.0, importance 0.5).
fuseHits(
  [{ id: 'A', bm25: -5 }, { id: 'B', bm25: -1 }],
  [{ id: 'B', cosine: 1.0 }],
  new Map([['A', { importance: 0.6, created_at: NOW }], ['B', { importance: 0.5, created_at: NOW }]]),
  weights, NOW,
);
// => A: 0.56, B: 0.55  (A wins)

// Add one irrelevant, low-importance junk candidate C with an extreme bm25
// magnitude (SQLite bm25() is unbounded — a keyword-stuffed/duplicated
// document can produce an arbitrarily large negative score).
fuseHits(
  [{ id: 'A', bm25: -5 }, { id: 'B', bm25: -1 }, { id: 'C', bm25: -50 }],
  [{ id: 'B', cosine: 1.0 }],
  new Map([
    ['A', { importance: 0.6, created_at: NOW }],
    ['B', { importance: 0.5, created_at: NOW }],
    ['C', { importance: 0.1, created_at: NOW }],
  ]),
  weights, NOW,
);
// => B: 0.55, C: 0.51, A: 0.19  (B wins — A's own signals never changed)
```

Actually executed via `npx vitest run` against a temp file; output confirmed:
`BASELINE scores { A: 0.56, B: 0.55 }` then `WITH-JUNK-C scores { B: 0.55, C: 0.51, A: 0.19 }`.

## Landmines checked and CLOSED (negative results)

- **`validityFilterClause`/`as_of` NULL hazard** — CLOSED. `memories.valid_from` is
  NOT NULL by construction: `InsertInput.valid_from ?? now` at every insert path, and
  migration 006 backfilled every pre-existing NULL row to `created_at`. So the `as_of`
  branch's `valid_from <= ?` can never silently drop a legacy row via SQL
  NULL-propagation — there is no row with `valid_from IS NULL` to trip it. The
  no-`as_of` branch (`valid_to IS NULL OR valid_to > now`) is correct and intentionally
  documented (a future `valid_to` must stay visible — see the CLAUDE.md incident
  this clause already fixed). Did not find a construction where a genuinely-invalidated
  fact survives, or a still-true fact is hidden.
- **min-max normalization degenerate inputs (empty/single-hit/all-equal/negative)** —
  CLOSED for the shapes the landmine names. `normalizeScores` explicitly special-cases
  `range === 0` (covers empty via early-return, single-hit, and all-equal) to return
  all-1s rather than NaN — verified against `tests/search/fuse.test.ts`'s existing
  coverage, all passing. Cosine scores (`1/(1+distance)`) are structurally always in
  `(0,1]`, never negative. **However** the UNBOUNDED-magnitude case (not literally
  "negative" but the same normalization-fragility family) is very much NOT closed —
  see Finding #1, which is the real exploitable edge case here.
- **ADR-010 usefulness/epsilon Laplace smoothing** — CLOSED, no ranking-inversion
  path found. `(used+1)/(used+corrected+2)` is bounded to `(0,1)`, monotonic in both
  directions, and symmetric: an atom with equal `used`/`corrected` evidence returns
  to the neutral 0.5 rather than being wrongly promoted or demoted. `epsilon`'s
  default weight (0.1) bounds how much this component can move a score regardless.
- **Fusion config no-op class (landmine #1, beyond the already-fixed P0.1)** — audited
  every field in `search.{alpha..theta, governance.maxComponentWeight, queryRewrite.*}`,
  `crossEncoder.*`, and `multiHop.*`: each one traces to a real consumer
  (`resolvePresetWeights`/`applyFusionGovernance`/`resolveRerankOpts`/
  `resolveDecomposeOpts`/`resolveQueryRewriteOpts`). Did not find a second config-level
  instance of P0.1's class. The one sibling instance that DOES exist is at the
  route/tool layer, not the config layer — see Finding #2 (`mode`).

## Notes on scope

`src/storage/entities.ts::memoryIdsForEntitiesAsOf` (the entity+as_of intersection
FEAT-453 §3.3 relies on) was read for context but is outside the assigned file list —
flagging only that its SQL logic (scalar `MAX`/`MIN` clipping of the two bitemporal
windows) looked structurally sound on inspection, not independently verified with a
repro.
