/**
 * Search orchestrator — hybrid FTS5 + vector + score fusion.
 *
 * Flow:
 *  1. FTS5 BM25 query on memories_fts
 *  2. embed(query) via EmbedProvider → vec.search() (mock or real)
 *  3. fuseHits — merge FTS + cosine scores
 *  4. apply SQL filters (type, repo, project, since) on the fused id set
 *  5. join full Memory records, return top-k hits
 *
 * VecFilter is intentionally empty on vector search calls because sqlite-vec
 * does not support pre-filtering. All filters are applied post-fusion.
 */

import type { DB } from '../storage/db.js';
import type { EmbedProvider } from '../contracts/index.js';
import type { Memory, MemoryType } from '../contracts/index.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';
import { fuseHits, normalizeScores, type FusedHit } from './fuse.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { usefulnessScores } from '../storage/usefulness.js';
import { EntityRepo } from '../storage/entities.js';

export interface SearchFilters {
  type?: string[];
  repo?: string;
  /**
   * Project filter (FEAT-423). Exact match on `memories.project`. A single
   * string → `project = ?`; a string[] → `project IN (...)` (OR-semantics,
   * mirrors `type[]`). Empty array = no constraint. Absent → all projects.
   */
  project?: string | string[];
  /**
   * Agent filter (FEAT-423 nice-to-have). Exact match on `memories.agent`
   * (the provenance `agent`/`agent_type` populated at ingest). Single string
   * or string[] (IN). Absent → all agents. Whether this excludes non-matches
   * (hard filter) or merely re-ranks matches upward (soft boost) is governed
   * by `agentMode` below.
   */
  agent?: string | string[];
  /**
   * FEAT-426 (role-scoped soft-boost recall, FEAT-219 consumer): selects how
   * `agent` above is applied.
   *  - 'filter' (default, omitted): current behavior — `agent` is a HARD
   *    filter, non-matching atoms are excluded at the SQL layer post-fusion.
   *    Byte-identical to pre-FEAT-426 behavior; existing callers are
   *    unaffected without any code change.
   *  - 'boost': `agent` is NOT applied as a SQL filter — every otherwise-
   *    matching atom stays in the result set, but atoms whose
   *    `memories.agent` matches get the η agent-match bonus (see fuse.ts),
   *    ranking them higher without excluding anyone else. Requires
   *    `weights.eta > 0` to have any effect (eta defaults to 0 = OFF).
   * Ignored when `agent` is undefined.
   */
  agentMode?: 'filter' | 'boost';
  since?: number;  // epoch ms lower bound on created_at
  /**
   * Bitemporal time-travel (FEAT-401, ADR-001/ADR-005): return memories as
   * they stood at this instant (epoch ms) rather than the current snapshot.
   * Absent = current behavior (only currently-valid rows).
   */
  as_of?: number;
  /**
   * Entity filter (FEAT-402 slice 2 AC-4). Resolved through
   * EntityRepo.resolveIds (AC-9 normalize seam: exact match, then LIKE
   * substring fallback) to one or more entities.id, then intersected with
   * the FTS+vec candidate set BEFORE fusion — the result is all-and-only
   * entity-linked members of that candidate set, not a post-fusion filter.
   * An unresolvable entity name yields zero results (not an unfiltered
   * search).
   */
  entity?: string;
}

export interface SearchHit {
  id: string;
  type: MemoryType;
  text: string;
  score: number;
  source: 'fts' | 'vec' | 'both';
}

export interface SearchOpts {
  db: DB;
  embed: EmbedProvider;
  weights: { alpha: number; beta: number; gamma: number; delta: number; epsilon?: number; zeta?: number; eta?: number };
  /** Multiplier used by vector search (cap to limit vector scan) */
  vecK?: number;
  /**
   * SLICE-410-3: when true, search() returns SearchDebugHit[] — the
   * per-candidate fusion intermediates (raw+normalized bm25/cosine,
   * importance, freshness, usefulness, entityBonus, effective weights, and
   * the final fused score) instead of collapsing to SearchHit[]. Every
   * other step (candidate gathering, entity filter, post-fusion SQL
   * filters, validity/as_of, limit, ranking order) is unchanged — debug is
   * purely an alternate projection of the same fused list, so debug:false
   * or omitted is byte-identical to pre-change behavior (AC-2).
   */
  debug?: boolean;
}

/**
 * Per-candidate fusion breakdown (SLICE-410-3 AC-1) — the upstream contract
 * for SLICE-410-6's search-debug dashboard page. Mirrors the components
 * `fuseHits`/`fuseScores` (fuse.ts) compute internally and normally discard.
 *
 * Sentinel (AC-4): when a leg has no hit for this candidate (e.g. embed
 * provider down → no vector leg at all), that leg's `raw` is `null` and
 * `normalized` is `0` — identical to the no-signal default `fuseHits`
 * already uses internally, so `score` stays reproducible from these fields
 * even in a degraded (FTS-only or vec-only) run.
 *
 * `usefulness`/`entityBonus`/`weights` are always the *effective* values
 * actually fed into `fuseScores` (defaults resolved, e.g. usefulness 0.5 /
 * entityBonus 0 / zeta 0) so `score` can be reconstructed exactly as:
 *   weights.alpha * bm25.normalized + weights.beta * cosine.normalized
 *   + weights.gamma * importance + weights.delta * freshness
 *   + weights.epsilon * usefulness + weights.zeta * entityBonus
 */
export interface SearchDebugHit {
  id: string;
  source: 'fts' | 'vec' | 'both';
  bm25: { raw: number | null; normalized: number };
  cosine: { raw: number | null; normalized: number };
  importance: number;
  freshness: number;
  usefulness: number;
  entityBonus: number;
  weights: { alpha: number; beta: number; gamma: number; delta: number; epsilon: number; zeta: number };
  score: number;
}

/**
 * Sanitize a free-form query string for safe use with the FTS5 `MATCH` operator.
 *
 * FTS5 treats several characters as operators (`-` negation, `*` wildcard,
 * `"` phrase, `^` column, `AND`/`OR`/`NOT` connectives). Without sanitization,
 * a query like `sqlite-vec` triggers `fts5: syntax error near "-"` because `-`
 * is parsed as a negation prefix.
 *
 * Strategy: split on whitespace, wrap each token in double quotes (treating
 * each as a literal phrase), and escape embedded `"` by doubling it per the
 * FTS5 phrase-literal rule. Multi-token queries become implicit AND.
 *
 * Trade-off: explicit FTS5 operators (e.g., `cat OR dog`, `"exact phrase"`,
 * `prefix*`) are NOT honored in v1 — every input is treated as a bag of
 * literal phrases. This is the right default for an agent-driven search
 * surface; an `advanced` flag can be added later if needed.
 */
function escapeFtsQuery(q: string): string {
  return q.trim().split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

/**
 * Bitemporal validity SQL clause (FEAT-401) — the ONE shared filter used by
 * every caller of search() (GET /search, POST /recall, the eval harness).
 * There is deliberately no second implementation anywhere else: the CLI
 * `--as-of` flag and the API `as_of` filter both terminate here because the
 * CLI is a thin HTTP client of the same routes that call search().
 *
 *  - No as_of (undefined): current snapshot — only rows with valid_to IS
 *    NULL surface, byte-identical to pre-FEAT-401 behavior (AC-2).
 *  - as_of = T: the row valid AT INSTANT T — valid_from <= T AND (valid_to
 *    IS NULL OR valid_to > T). Half-open interval [valid_from, valid_to):
 *    at the exact instant a supersede/invalidate event lands, the new
 *    generation is already the one considered valid (AC-5).
 */
export function validityFilterClause(asOf?: number): { clause: string; params: number[] } {
  if (asOf === undefined) {
    return { clause: 'valid_to IS NULL', params: [] };
  }
  return { clause: 'valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)', params: [asOf, asOf] };
}

/**
 * Parse an `as_of` wire value (ISO-8601 date-time string) into epoch ms.
 * Shared by every route that accepts the filter (GET /search query param,
 * POST /recall body) so a malformed value is rejected identically everywhere
 * — one parsing path, not a per-route reimplementation. Returns undefined
 * for an absent/empty value; throws for a present-but-unparseable value so
 * callers can turn it into a 400.
 */
export function parseAsOf(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid as_of value: ${value} (expected ISO-8601 date-time)`);
  }
  return ms;
}

/**
 * Deterministic fake vector for testing — seeded by text hash, dim
 * defaults to DEFAULT_EMBED_DIM (1024). Exported so tests can call it
 * directly without importing the EmbedProvider. Pass `dim` to generate a
 * fixture vector matching a non-default schema (FEAT-409 AC-2).
 */
export function makeFakeVec(text: string, dim: number = DEFAULT_EMBED_DIM): Float32Array {
  const v = new Float32Array(dim);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) & 0xffffffff;
  }
  for (let i = 0; i < dim; i++) {
    v[i] = Math.sin(hash * 0.001 + i * 0.01);
  }
  return v;
}

/**
 * Compute the ζ entity-relevance bonus map (FEAT-402 slice 2 AC-6): for
 * every known entity whose normalized name appears as a substring of the
 * (lowercased) query text, any candidate id linked to that entity gets a
 * bonus of 1. Only called when `search.zeta > 0` — with the default
 * zeta=0 this function never runs, which is what makes the AC-6 snapshot
 * guarantee (identical ranking at zeta=0) hold structurally, not just
 * numerically.
 */
function entityBonusForQuery(db: DB, query: string, candidateIds: Set<string>): Map<string, number> {
  const q = query.trim().toLowerCase();
  if (!q || candidateIds.size === 0) return new Map();

  const entityRows = db.prepare('SELECT id, name FROM entities').all() as Array<{ id: string; name: string }>;
  const matchedEntityIds = entityRows.filter(r => r.name && q.includes(r.name)).map(r => r.id);
  if (matchedEntityIds.length === 0) return new Map();

  const idPh = Array.from(candidateIds).map(() => '?').join(',');
  const entPh = matchedEntityIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT DISTINCT memory_id FROM memory_entities WHERE memory_id IN (${idPh}) AND entity_id IN (${entPh})`
  ).all(...candidateIds, ...matchedEntityIds) as Array<{ memory_id: string }>;

  const bonus = new Map<string, number>();
  for (const row of rows) bonus.set(row.memory_id, 1);
  return bonus;
}

/**
 * Compute the η agent-match bonus map (FEAT-426): every candidate id whose
 * `memories.agent` matches one of the caller's preferred agent(s) gets a
 * bonus of 1. Only called when `filters.agentMode === 'boost'` — the
 * complementary HARD filter path ('filter', the default) never calls this
 * and instead excludes non-matches at the SQL layer via `addEqOrIn('agent',
 * ...)` below, exactly as it did before FEAT-426.
 */
function agentBonusForFilter(db: DB, agent: string | string[], candidateIds: Set<string>): Map<string, number> {
  if (candidateIds.size === 0) return new Map();
  const agents = Array.isArray(agent) ? agent : [agent];
  if (agents.length === 0) return new Map();

  const idPh = Array.from(candidateIds).map(() => '?').join(',');
  const agentPh = agents.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id FROM memories WHERE id IN (${idPh}) AND agent IN (${agentPh})`
  ).all(...candidateIds, ...agents) as Array<{ id: string }>;

  const bonus = new Map<string, number>();
  for (const row of rows) bonus.set(row.id, 1);
  return bonus;
}

export function search(
  query: string,
  filters: SearchFilters,
  limit: number,
  opts: SearchOpts & { debug: true }
): Promise<SearchDebugHit[]>;
export function search(
  query: string,
  filters: SearchFilters,
  limit: number,
  opts: SearchOpts
): Promise<SearchHit[]>;
export async function search(
  query: string,
  filters: SearchFilters,
  limit: number,
  opts: SearchOpts
): Promise<SearchHit[] | SearchDebugHit[]> {
  const { db, embed, weights } = opts;
  const vecK = opts.vecK ?? Math.max(limit * 4, 50);

  // 1. FTS5 BM25 — run only if query is non-empty
  const ftsHits: Array<{ id: string; bm25: number }> = [];
  if (query.trim()) {
    const ftsQuery = escapeFtsQuery(query);
    try {
      const rows = db.prepare(`
        SELECT m.id, bm25(memories_fts) AS bm25
        FROM memories_fts
        JOIN memories m ON m.rowid = memories_fts.rowid
        WHERE memories_fts MATCH ?
        ORDER BY bm25
        LIMIT ?
      `).all(ftsQuery, vecK) as Array<{ id: string; bm25: number }>;
      ftsHits.push(...rows);
    } catch {
      // FTS5 rejected the query (rare with escapeFtsQuery sanitization).
      // Fall through to vector-only path.
    }
  }

  // 2. Vector search — always attempt; if embed fails, fall back to FTS-only
  const vecHits: Array<{ id: string; cosine: number }> = [];
  try {
    const vecs = await embed.embed([query]);
    const queryVec = vecs[0];
    if (!queryVec) throw new Error('embed provider returned empty result');
    const vecStore = new SqliteVecStore(db, embed.dim);
    // Pass empty filter to vec adapter — post-fusion filters applied below
    const raw = await vecStore.search(queryVec, vecK);
    vecHits.push(...raw.map(h => ({ id: h.id, cosine: h.score })));
  } catch {
    // Vector search unavailable (no rows, no provider) — FTS-only mode
  }

  // 2b. Entity filter (FEAT-402 slice 2 AC-4) — resolve `entity` to entity
  // ids (AC-9 normalize seam) and intersect the FTS+vec candidate set BEFORE
  // fusion, so the result is all-and-only entity-linked members of that
  // candidate set. An entity name that resolves to zero entities filters the
  // candidate set to empty (not "unfiltered") — search() returns [] below.
  let filteredFtsHits = ftsHits;
  let filteredVecHits = vecHits;
  if (filters.entity !== undefined) {
    const entityRepo = new EntityRepo(db);
    const entityIds = entityRepo.resolveIds(filters.entity);
    const linkedIds = entityRepo.memoryIdsForEntities(entityIds);
    filteredFtsHits = ftsHits.filter(h => linkedIds.has(h.id));
    filteredVecHits = vecHits.filter(h => linkedIds.has(h.id));
  }

  // 3. Load meta for all candidate ids (importance + created_at for freshness)
  const allIds = new Set([...filteredFtsHits.map(h => h.id), ...filteredVecHits.map(h => h.id)]);
  if (allIds.size === 0) return [];

  const placeholders = Array.from(allIds).map(() => '?').join(',');
  const metaRows = db.prepare(
    `SELECT id, importance, created_at FROM memories WHERE id IN (${placeholders})`
  ).all(...allIds) as Array<{ id: string; importance: number; created_at: number }>;

  const metaMap = new Map(metaRows.map(r => [r.id, { importance: r.importance, created_at: r.created_at }]));

  // 4. Fuse — usefulness (ADR-010 v1.x) joins as the ε component. ζ
  // (FEAT-402 AC-6) joins as an entity-relevance bonus: DEFAULT 0 (config
  // search.zeta) means the term is skipped entirely — no query, no DB scan,
  // no change to ranking order versus pre-AC-6 behavior.
  const usefulness = usefulnessScores(db, Array.from(allIds));
  const zeta = weights.zeta ?? 0;
  const entityBonus = zeta > 0 ? entityBonusForQuery(db, query, allIds) : undefined;
  // FEAT-426: η agent-match soft-boost — only computed when the caller
  // opted `agent` into 'boost' mode (default 'filter' skips this entirely;
  // the hard-filter clause in the post-fusion filter step below is
  // unchanged for that default path).
  const eta = weights.eta ?? 0;
  const agentMode = filters.agentMode ?? 'filter';
  const agentBonus = (eta > 0 && agentMode === 'boost' && filters.agent !== undefined)
    ? agentBonusForFilter(db, filters.agent, allIds)
    : undefined;
  const nowMs = Date.now();
  const fused = fuseHits(filteredFtsHits, filteredVecHits, metaMap, weights, nowMs, undefined, usefulness, entityBonus, agentBonus);

  // 5. Apply post-fusion SQL filters then join full memory records
  //    Build filter clauses dynamically
  const filterClauses: string[] = [];
  const filterParams: (string | number)[] = [];

  if (filters.type && filters.type.length > 0) {
    const ph = filters.type.map(() => '?').join(',');
    filterClauses.push(`type IN (${ph})`);
    filterParams.push(...filters.type);
  }
  if (filters.repo !== undefined) {
    filterClauses.push('repo = ?');
    filterParams.push(filters.repo);
  }
  // FEAT-423: project/agent accept a single value (`col = ?`) or a list
  // (`col IN (...)`, OR-semantics like `type[]`). An empty list is treated as
  // no constraint, never as "match nothing".
  const addEqOrIn = (col: 'project' | 'agent', val: string | string[]) => {
    if (Array.isArray(val)) {
      if (val.length === 0) return;
      filterClauses.push(`${col} IN (${val.map(() => '?').join(',')})`);
      filterParams.push(...val);
    } else {
      filterClauses.push(`${col} = ?`);
      filterParams.push(val);
    }
  };
  if (filters.project !== undefined) addEqOrIn('project', filters.project);
  // FEAT-426: agent is a HARD filter only in the default 'filter' mode
  // (byte-identical to pre-FEAT-426 behavior). In 'boost' mode the SQL
  // filter is skipped entirely — non-matches stay in the result set and are
  // instead re-ranked via the η agentBonus computed above.
  if (filters.agent !== undefined && agentMode === 'filter') addEqOrIn('agent', filters.agent);
  if (filters.since !== undefined) {
    filterClauses.push('created_at >= ?');
    filterParams.push(filters.since);
  }

  // Fetch full memory records in one query using IN clause
  const fusedIds = fused.map(h => h.id);
  const idPlaceholders = fusedIds.map(() => '?').join(',');
  // Atom v3 (ADR-001): invalidated memories (valid_to set) must never surface
  // in a current-snapshot recall — why_memory can still fetch them by id
  // directly. FEAT-401: when as_of is set, the snapshot rule is replaced by
  // the bitemporal validity window so a past-valid (now superseded) memory
  // can surface again for a point-in-time query.
  const { clause: validityClause, params: validityParams } = validityFilterClause(filters.as_of);
  const whereFilter = filterClauses.length > 0 ? ` AND ${filterClauses.join(' AND ')}` : '';
  const sql = `SELECT id, type, text FROM memories WHERE id IN (${idPlaceholders}) AND ${validityClause}${whereFilter}`;
  const memRows = db.prepare(sql).all(...fusedIds, ...validityParams, ...filterParams) as Array<{ id: string; type: MemoryType; text: string }>;

  const memMap = new Map(memRows.map(r => [r.id, r]));

  // 6a. Debug projection (SLICE-410-3 AC-1) — recompute the same
  // normalization fuseHits() applies internally (normalizeScores is
  // exported from fuse.ts for exactly this reuse) so components are
  // guaranteed consistent with `fused[].score`, without touching fuse.ts.
  if (opts.debug) {
    const bm25RawMap = new Map(filteredFtsHits.map(h => [h.id, h.bm25]));
    const normBm25Arr = normalizeScores(filteredFtsHits.map(h => -h.bm25));
    const normBm25Map = new Map(filteredFtsHits.map((h, i) => [h.id, normBm25Arr[i] ?? 0]));

    const cosineRawMap = new Map(filteredVecHits.map(h => [h.id, h.cosine]));
    const normCosineArr = normalizeScores(filteredVecHits.map(h => h.cosine));
    const normCosineMap = new Map(filteredVecHits.map((h, i) => [h.id, normCosineArr[i] ?? 0]));

    // Freshness half-life: fuse.ts fuseHits() default freshnessDecayDays=30,
    // which search() always uses (passes `undefined` through to that
    // default). Kept identical here so freshness — and thus `score` — stays
    // reproducible from the documented weights (AC-3).
    const freshnessDecayDays = 30;
    // fuseScores() divides the raw weighted sum by the sum of active weights
    // to keep scores in [0,1] (wire contract). Report weightSum-normalized
    // weights here so `score` stays exactly reproducible as
    // Σ weights.* × component from this object alone.
    const rawWeightSum =
      weights.alpha + weights.beta + weights.gamma + weights.delta +
      (weights.epsilon ?? 0) + zeta;
    const weightSum = rawWeightSum === 0 ? 1 : rawWeightSum;
    const effectiveWeights = {
      alpha: weights.alpha / weightSum,
      beta: weights.beta / weightSum,
      gamma: weights.gamma / weightSum,
      delta: weights.delta / weightSum,
      epsilon: (weights.epsilon ?? 0) / weightSum,
      zeta: zeta / weightSum,
    };

    const debugResults: SearchDebugHit[] = [];
    for (const hit of fused) {
      if (!memMap.has(hit.id)) continue;  // filtered out, same as SearchHit path
      const meta = metaMap.get(hit.id);
      const importance = meta?.importance ?? 0.5;
      const createdAt = meta?.created_at ?? nowMs;
      const ageDays = (nowMs - createdAt) / (24 * 60 * 60 * 1000);
      const freshness = Math.exp(-ageDays / freshnessDecayDays);

      debugResults.push({
        id: hit.id,
        source: hit.source,
        bm25: { raw: bm25RawMap.get(hit.id) ?? null, normalized: normBm25Map.get(hit.id) ?? 0 },
        cosine: { raw: cosineRawMap.get(hit.id) ?? null, normalized: normCosineMap.get(hit.id) ?? 0 },
        importance,
        freshness,
        usefulness: usefulness.get(hit.id) ?? 0.5,
        entityBonus: entityBonus?.get(hit.id) ?? 0,
        weights: effectiveWeights,
        score: hit.score,
      });
      if (debugResults.length >= limit) break;
    }
    return debugResults;
  }

  // 6. Build result — preserve fused ranking order, skip filtered-out ids
  const results: SearchHit[] = [];
  for (const hit of fused) {
    const mem = memMap.get(hit.id);
    if (!mem) continue;  // filtered out
    results.push({
      id: hit.id,
      type: mem.type,
      text: mem.text,
      score: hit.score,
      source: hit.source
    });
    if (results.length >= limit) break;
  }

  return results;
}
