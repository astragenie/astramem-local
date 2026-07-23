/**
 * Score fusion for hybrid BM25 + cosine + importance + freshness ranking.
 *
 * Formula: raw   = α·norm(bm25) + β·norm(cosine) + γ·importance + δ·freshness
 *                  + ε·usefulness + ζ·entityBonus + η·agentBonus + θ·uncontestedBonus
 *          score = raw / (α + β + γ + δ + ε + ζ + η + θ)   ["active weight sum"]
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
 * θ (theta, issue #352B) is a supersession/correction FRESHNESS bonus, the
 * 8th and newest governed component. It differs from ζ/η in its no-signal
 * DEFAULT: `uncontestedBonus` defaults to **1**, not 0 — the common case for
 * this signal is "this atom carries no open correction flag," so an
 * unflagged candidate gets the bonus by default; only a candidate currently
 * flagged as the loser side of an OPEN (pending) `kind='contradiction'`
 * consolidation proposal (search.ts's `correctionSignalForCandidates`) gets
 * `uncontestedBonus: 0`, losing that share of the fused score relative to
 * its uncontested peers. This keeps the design purely additive (no negative
 * weight, no risk to the [0,1] wire contract) while still achieving a
 * down-rank-relative-to-fresh-peers effect for the flagged atom. DEFAULT 0
 * (OFF) — with the default `theta=0` weight the term contributes exactly 0
 * and ranking is byte-identical to pre-#352B behavior, gated by
 * `applyFusionGovernance`'s eval-evidence check exactly like η. See Ask B in
 * issue #352: properly-superseded atoms are already hard-hidden by
 * `validityFilterClause` — this component targets the narrower gap of atoms
 * that are corrected-but-not-yet-superseded (a contradiction was detected,
 * but no supersede edge exists yet).
 *
 * Normalizing by the active weight sum is a per-call constant scalar (the
 * weights config doesn't vary across hits in the same search), so it never
 * changes relative ranking order for a fixed weight config — it is a
 * monotone rescaling, applied uniformly to every candidate.
 *
 * FEAT-428 (fusion-model governance): the functions in this file are pure —
 * they trust the `weights` they're given and never reach into config or the
 * eval harness themselves. Governance (a component ceiling on every weight,
 * and an eval-evidence gate that refuses to let a configured `eta > 0`
 * activate without a passing ADR-005 harness run backing it) is enforced
 * upstream of here, once, at config-load time — see `applyFusionGovernance`
 * in src/config/config.ts and the evidence table in src/eval/eval-evidence.ts.
 * A caller that hand-builds a weights object (as most of this file's own
 * tests do) bypasses that gate deliberately, the same way it already
 * bypasses `defaultConfig()` — governance is a config-loading concern, not a
 * fusion-math invariant.
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
  /**
   * issue #352B supersession/correction freshness bonus, 0 or 1; UNLIKE
   * entityBonus/agentBonus, the no-signal DEFAULT is **1** (uncontested) —
   * see the module doc comment's θ section for why. Only a candidate
   * flagged as the loser side of an open contradiction proposal gets an
   * explicit 0.
   */
  uncontestedBonus?: number;
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
  /** supersession/correction freshness weight (θ); omitted or 0 = OFF
   *  (issue #352B default, ranking unchanged) — governed the same way η is. */
  theta?: number;
}

/** Config-facing normalization mode for {@link normalizeScores} (score-phase
 *  Track I). See `search.normalization` in `src/config/config.ts`. */
export type NormalizationMode = 'minmax' | 'winsorized';

const WINSORIZE_LOWER_PCT = 0.05;
const WINSORIZE_UPPER_PCT = 0.95;

/**
 * Linear-interpolated percentile over an ALREADY-SORTED ascending array (same
 * convention as numpy's default `interpolation='linear'`). Internal helper
 * for the 'winsorized' mode below.
 */
function percentileOfSorted(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 1) return sortedAsc[0]!;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo]!;
  const frac = idx - lo;
  return sortedAsc[lo]! + (sortedAsc[hi]! - sortedAsc[lo]!) * frac;
}

/**
 * Clip every value in `scores` to [p5, p95] of the SAME array. Used only by
 * 'winsorized' mode — see `normalizeScores`'s doc comment for the rationale.
 */
function winsorize(scores: number[]): number[] {
  const sorted = [...scores].sort((a, b) => a - b);
  const lo = percentileOfSorted(sorted, WINSORIZE_LOWER_PCT);
  const hi = percentileOfSorted(sorted, WINSORIZE_UPPER_PCT);
  return scores.map(s => Math.min(hi, Math.max(lo, s)));
}

/**
 * Normalize an array of raw scores to [0,1] range.
 * If all values are equal (range = 0) returns all ones.
 *
 * `mode` (score-phase Track I, `search.normalization` config key):
 * - 'minmax' (default): plain min-max over the raw values, byte-identical to
 *   this function's pre-existing behavior.
 * - 'winsorized': clips every value to its own array's [p5, p95] BEFORE
 *   min-max. SQLite bm25/cosine are unbounded, so a single outlier candidate
 *   can stretch plain min-max's range so far that every OTHER candidate's
 *   normalized score compresses toward the same corner — erasing the
 *   separation between them (the "pool tax": within one `fuseHits()` call,
 *   an unrelated outlier can invert two other candidates' relative fused
 *   score once combined with components the outlier didn't distort, e.g.
 *   importance/freshness). Clipping first bounds the outlier's influence on
 *   the min-max range, restoring that separation. Needs a reasonably sized
 *   candidate array to have any effect — with very few points (2-3) the p5/
 *   p95 interpolation sits right next to the extremes and clipping is close
 *   to a no-op, which is expected (see tests/search/fuse.test.ts).
 */
export function normalizeScores(scores: number[], mode: NormalizationMode = 'minmax'): number[] {
  if (scores.length === 0) return [];
  const source = mode === 'winsorized' ? winsorize(scores) : scores;
  const min = Math.min(...source);
  const max = Math.max(...source);
  const range = max - min;
  // All-equal (including single-hit): every score is equally the best match
  // within this component. Returning 0 would erase the component's signal
  // entirely (a lone FTS hit would lose its whole BM25 contribution).
  if (range === 0) return scores.map(() => 1);
  return source.map(s => (s - min) / range);
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
    (input.eta ?? 0) * (input.agentBonus ?? 0) +
    (input.theta ?? 0) * (input.uncontestedBonus ?? 1);

  const weightSum =
    input.alpha + input.beta + input.gamma + input.delta +
    (input.epsilon ?? 0) + (input.zeta ?? 0) + (input.eta ?? 0) + (input.theta ?? 0);

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
 * @param uncontested Optional id → supersession/correction freshness bonus (issue #352B);
 *   missing ids default to 1 (uncontested) — the INVERSE default of entityBonus/agentBonus, since
 *   the common case here is "no open correction flag" (see fuse.ts module doc's θ section)
 */
export function fuseHits(
  ftsHits: Array<{ id: string; bm25: number }>,
  vecHits: Array<{ id: string; cosine: number }>,
  metas: Map<string, { importance: number; created_at: number }>,
  weights: {
    alpha: number; beta: number; gamma: number; delta: number; epsilon?: number; zeta?: number; eta?: number; theta?: number;
    /** score-phase Track I: `search.normalization` config key. Omitted = 'minmax'
     *  (byte-identical to pre-Track-I behavior) — see normalizeScores' doc comment. */
    normalization?: NormalizationMode;
  },
  nowMs: number,
  freshnessDecayDays = 30,
  usefulness?: Map<string, number>,
  entityBonus?: Map<string, number>,
  agentBonus?: Map<string, number>,
  uncontested?: Map<string, number>
): FusedHit[] {
  // Build per-id raw maps
  const ftsMap = new Map(ftsHits.map(h => [h.id, h.bm25]));
  const vecMap = new Map(vecHits.map(h => [h.id, h.cosine]));

  // Union of all candidate ids
  const ids = new Set([...ftsMap.keys(), ...vecMap.keys()]);

  // Normalize BM25 — SQLite bm25() returns negative values (lower = better match)
  // Negate so higher positive = better, then normalize
  const rawBm25Values = ftsHits.map(h => -h.bm25);  // negate
  const normBm25Arr = normalizeScores(rawBm25Values, weights.normalization);
  const normBm25Map = new Map(ftsHits.map((h, i) => [h.id, normBm25Arr[i] ?? 0]));

  // Normalize cosine scores
  const rawCosineValues = vecHits.map(h => h.cosine);
  const normCosineArr = normalizeScores(rawCosineValues, weights.normalization);
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

    // issue #190: pick only the fusion weight keys off `weights` explicitly,
    // rather than spreading the whole object in — production callers now
    // pass the full `Config['search']`, which carries its OWN `usefulness`
    // key (the implicit-positive-sweep config sub-object, an unrelated
    // meaning from the `usefulness` SCORE field above). A trailing
    // `...weights` spread would silently clobber the real per-atom
    // usefulness score with that config object on every real search call.
    const score = fuseScores({
      normBm25,
      normCosine,
      importance,
      freshness,
      usefulness: usefulness?.get(id),
      entityBonus: entityBonus?.get(id),
      agentBonus: agentBonus?.get(id),
      uncontestedBonus: uncontested?.get(id),
      alpha: weights.alpha,
      beta: weights.beta,
      gamma: weights.gamma,
      delta: weights.delta,
      epsilon: weights.epsilon,
      zeta: weights.zeta,
      eta: weights.eta,
      theta: weights.theta,
    });

    const inFts = ftsMap.has(id);
    const inVec = vecMap.has(id);
    const source: FusedHit['source'] = inFts && inVec ? 'both' : inFts ? 'fts' : 'vec';

    results.push({ id, score, source });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}
