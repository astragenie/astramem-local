/**
 * Score fusion for hybrid BM25 + cosine + importance + freshness ranking.
 *
 * Formula: raw   = α·norm(bm25) + β·norm(cosine) + γ·importance + δ·freshness
 *                  + ε·usefulness + ζ·entityBonus + η·agentBonus
 *          score = raw / (α + β + γ + δ + ε + ζ + η)   ["active weight sum"]
 *
 * Wire-contract invariant: score MUST land in [0,1] (plugin Zod schema,
 * memory-plugin#8) so the daemon response validates. Every component input
 * is already bounded to [0,1] (normBm25/normCosine via normalizeScores,
 * importance/freshness/usefulness by construction, entityBonus ∈ {0,1} —
 * see entityBonusForQuery), so any convex-combination weight config keeps
 * `raw` in [0, weightSum]; dividing by weightSum restores [0,1] even when
 * the configured weights don't sum to 1 (default config sums to 1.1 — see
 * config.ts search defaults — which without this normalization pushed
 * perfect-match scores to ~1.04 and broke the wire contract).
 *
 * Defaults: α=β=0.4, γ=δ=ε=0.1, ζ=0. Pulled from config.search. The
 * usefulness component (ADR-010 v1.x) is Laplace-smoothed to a neutral 0.5
 * for atoms with no recall_used/memory_corrected signal, so ε only
 * reshuffles atoms that have actually accumulated evidence.
 *
 * ζ (zeta, FEAT-402 slice 2 AC-6) is a distinct entity-relevance bonus: 1
 * when a candidate is entity-linked to an entity mentioned in the query
 * text, 0 otherwise — no-signal default is 0 (not usefulness's neutral 0.5),
 * so with the default `zeta=0` weight the term contributes exactly 0 to
 * every candidate and ranking order is byte-identical to pre-AC-6 behavior
 * (see tests/search/fuse.test.ts zeta=0 no-op case and the eval harness
 * zeta=0 snapshot test).
 *
 * η (eta, FEAT-426) is an agent-match SOFT-BOOST, structurally identical to
 * ζ: 1 when a candidate's `memories.agent` matches the caller's preferred
 * agent(s), 0 otherwise. DEFAULT 0 (OFF) — with the default `eta=0` weight
 * the term contributes exactly 0 and ranking is byte-identical to
 * pre-FEAT-426 behavior. This is deliberately NOT the same code path as the
 * existing `SearchFilters.agent` HARD filter (FEAT-423): the hard filter
 * excludes non-matching atoms at the SQL layer before fusion ever runs; the
 * η boost instead lets non-matching atoms stay in the candidate set and
 * merely re-ranks matches upward. `search.ts` decides which one applies
 * based on `SearchFilters.agentMode` ('filter', the default, vs 'boost').
 *
 * Normalizing by the active weight sum is a per-call constant scalar (the
 * weights config doesn't vary across hits in the same search), so it never
 * changes relative ranking order for a fixed weight config — it is a
 * monotone rescaling, applied uniformly to every candidate.
 */

export interface FuseInput {
  normBm25: number;    // already normalized to [0,1]
  normCosine: number;  // already normalized to [0,1]
  importance: number;  // raw from memories.importance [0,1]
  freshness: number;   // caller computes from created_at, [0,1]
  /** ADR-010 usefulness score [0,1]; 0.5 = no signal. */
  usefulness?: number;
  /** FEAT-402 AC-6 entity-relevance bonus, 0 or 1; 0 = no signal (unlike usefulness). */
  entityBonus?: number;
  /** FEAT-426 agent-match soft-boost, 0 or 1; 0 = no signal (same shape as entityBonus). */
  agentBonus?: number;
  alpha: number;       // bm25 weight
  beta: number;        // cosine weight
  gamma: number;       // importance weight
  delta: number;       // freshness weight
  /** usefulness weight; omitted = 0 (usefulness ignored) */
  epsilon?: number;
  /** entity-bonus weight; omitted or 0 = OFF (AC-6 default, ranking unchanged) */
  zeta?: number;
  /** agent-bonus weight; omitted or 0 = OFF (FEAT-426 default, ranking unchanged) */
  eta?: number;
}

/**
 * Normalize an array of raw scores to [0,1] range.
 * If all values are equal (range = 0) returns all ones.
 */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  // All-equal (including single-hit): every score is equally the best match
  // within this component. Returning 0 would erase the component's signal
  // entirely (a lone FTS hit would lose its whole BM25 contribution).
  if (range === 0) return scores.map(() => 1);
  return scores.map(s => (s - min) / range);
}

/**
 * Compute fused score for a single hit whose components are already normalized.
 *
 * Returns a value in [0,1]: the weighted sum is divided by the sum of the
 * active weights so the result stays in-range even when the configured
 * weights don't sum to 1 (see module doc comment). Guards the degenerate
 * all-zero-weights case by returning 0 rather than dividing by zero.
 */
export function fuseScores(input: FuseInput): number {
  const raw =
    input.alpha * input.normBm25 +
    input.beta  * input.normCosine +
    input.gamma * input.importance +
    input.delta * input.freshness +
    (input.epsilon ?? 0) * (input.usefulness ?? 0.5) +
    (input.zeta ?? 0) * (input.entityBonus ?? 0) +
    (input.eta ?? 0) * (input.agentBonus ?? 0);

  const weightSum =
    input.alpha + input.beta + input.gamma + input.delta +
    (input.epsilon ?? 0) + (input.zeta ?? 0) + (input.eta ?? 0);

  if (weightSum === 0) return 0;
  // Defense-in-depth: components are bounded to [0,1] at their sources, but a
  // future regression there must degrade to a capped score, not a wire-contract
  // violation that makes plugin clients reject the whole response.
  return Math.min(1, raw / weightSum);
}

export interface RawHit {
  id: string;
  bm25?: number;    // undefined if not returned by FTS
  cosine?: number;  // undefined if not returned by vector search
  importance: number;
  created_at: number;
}

export interface FusedHit {
  id: string;
  score: number;
  source: 'fts' | 'vec' | 'both';
}

/**
 * Fuse a set of raw BM25 hits + cosine hits into a single ranked list.
 *
 * @param ftsHits    Hits from FTS5, each with bm25 (negative in SQLite — we negate before normalization)
 * @param vecHits    Hits from vector search, each with cosine score [0,1] (1/(1+distance))
 * @param metas      Map of id → {importance, created_at} for all candidate ids
 * @param weights    α,β,γ,δ
 * @param nowMs      Current epoch ms for freshness computation
 * @param freshnessDecayDays  Half-life of freshness decay in days (default 30)
 * @param usefulness Optional id → usefulness score [0,1] (ADR-010); missing ids default to 0.5
 * @param entityBonus Optional id → entity-relevance bonus (FEAT-402 AC-6); missing ids default to 0
 * @param agentBonus Optional id → agent-match soft-boost (FEAT-426); missing ids default to 0
 */
export function fuseHits(
  ftsHits: Array<{ id: string; bm25: number }>,
  vecHits: Array<{ id: string; cosine: number }>,
  metas: Map<string, { importance: number; created_at: number }>,
  weights: { alpha: number; beta: number; gamma: number; delta: number; epsilon?: number; zeta?: number; eta?: number },
  nowMs: number,
  freshnessDecayDays = 30,
  usefulness?: Map<string, number>,
  entityBonus?: Map<string, number>,
  agentBonus?: Map<string, number>
): FusedHit[] {
  // Build per-id raw maps
  const ftsMap = new Map(ftsHits.map(h => [h.id, h.bm25]));
  const vecMap = new Map(vecHits.map(h => [h.id, h.cosine]));

  // Union of all candidate ids
  const ids = new Set([...ftsMap.keys(), ...vecMap.keys()]);

  // Normalize BM25 — SQLite bm25() returns negative values (lower = better match)
  // Negate so higher positive = better, then normalize
  const rawBm25Values = ftsHits.map(h => -h.bm25);  // negate
  const normBm25Arr = normalizeScores(rawBm25Values);
  const normBm25Map = new Map(ftsHits.map((h, i) => [h.id, normBm25Arr[i] ?? 0]));

  // Normalize cosine scores
  const rawCosineValues = vecHits.map(h => h.cosine);
  const normCosineArr = normalizeScores(rawCosineValues);
  const normCosineMap = new Map(vecHits.map((h, i) => [h.id, normCosineArr[i] ?? 0]));

  // Freshness: exponential decay, half-life = freshnessDecayDays
  const decayMs = freshnessDecayDays * 24 * 60 * 60 * 1000;

  const results: FusedHit[] = [];

  for (const id of ids) {
    const meta = metas.get(id);
    const importance = meta?.importance ?? 0.5;
    const createdAt = meta?.created_at ?? nowMs;
    const ageDays = (nowMs - createdAt) / (24 * 60 * 60 * 1000);
    // Clamp to 1: a future created_at (SaaS-sync clock skew — puller.ts stores
    // remote-minted timestamps verbatim) makes ageDays negative and exp() > 1,
    // which would push the fused score past the [0,1] wire contract.
    const freshness = Math.min(1, Math.exp(-ageDays / (decayMs / (24 * 60 * 60 * 1000))));

    const normBm25 = normBm25Map.get(id) ?? 0;
    const normCosine = normCosineMap.get(id) ?? 0;

    const score = fuseScores({
      normBm25,
      normCosine,
      importance,
      freshness,
      usefulness: usefulness?.get(id),
      entityBonus: entityBonus?.get(id),
      agentBonus: agentBonus?.get(id),
      ...weights
    });

    const inFts = ftsMap.has(id);
    const inVec = vecMap.has(id);
    const source: FusedHit['source'] = inFts && inVec ? 'both' : inFts ? 'fts' : 'vec';

    results.push({ id, score, source });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
