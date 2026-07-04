/**
 * Score fusion for hybrid BM25 + cosine + importance + freshness ranking.
 *
 * Formula: score = (α·norm(bm25) + β·norm(cosine) + γ·importance + δ·freshness
 *                    + ε·usefulness + ζ·entityBonus) / (α+β+γ+δ+ε+ζ)
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
 * Wire-contract invariant (memory-plugin#8): the fused score MUST land in
 * [0,1] — the plugin's Zod schema (src/contracts/wire.ts) rejects anything
 * outside that range. Every component input is already normalized to [0,1]
 * (normBm25/normCosine via normalizeScores(), importance/freshness/usefulness
 * by construction, entityBonus is 0 or 1), so the weighted sum divided by
 * the sum of the active weights is a convex combination and stays in [0,1].
 * Dividing by the weight sum rather than assuming it equals 1 matters
 * because the configured defaults (0.4+0.4+0.1+0.1+0.1 = 1.1) do not sum to
 * 1 — the un-normalized sum could exceed the wire contract's upper bound.
 * This is a monotone rescale for a fixed weight config, so it never changes
 * ranking order.
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
  alpha: number;       // bm25 weight
  beta: number;        // cosine weight
  gamma: number;       // importance weight
  delta: number;       // freshness weight
  /** usefulness weight; omitted = 0 (usefulness ignored) */
  epsilon?: number;
  /** entity-bonus weight; omitted or 0 = OFF (AC-6 default, ranking unchanged) */
  zeta?: number;
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
 * active weights (see module doc comment for the wire-contract rationale).
 */
export function fuseScores(input: FuseInput): number {
  const epsilon = input.epsilon ?? 0;
  const zeta = input.zeta ?? 0;
  const weightSum = input.alpha + input.beta + input.gamma + input.delta + epsilon + zeta;
  if (weightSum <= 0) return 0;

  const weightedSum =
    input.alpha * input.normBm25 +
    input.beta  * input.normCosine +
    input.gamma * input.importance +
    input.delta * input.freshness +
    epsilon * (input.usefulness ?? 0.5) +
    zeta * (input.entityBonus ?? 0);

  return weightedSum / weightSum;
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
 */
export function fuseHits(
  ftsHits: Array<{ id: string; bm25: number }>,
  vecHits: Array<{ id: string; cosine: number }>,
  metas: Map<string, { importance: number; created_at: number }>,
  weights: { alpha: number; beta: number; gamma: number; delta: number; epsilon?: number; zeta?: number },
  nowMs: number,
  freshnessDecayDays = 30,
  usefulness?: Map<string, number>,
  entityBonus?: Map<string, number>
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
    const freshness = Math.exp(-ageDays / (decayMs / (24 * 60 * 60 * 1000)));

    const normBm25 = normBm25Map.get(id) ?? 0;
    const normCosine = normCosineMap.get(id) ?? 0;

    const score = fuseScores({
      normBm25,
      normCosine,
      importance,
      freshness,
      usefulness: usefulness?.get(id),
      entityBonus: entityBonus?.get(id),
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
