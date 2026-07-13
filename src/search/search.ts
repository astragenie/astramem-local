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
import type { Memory, MemoryType, MemoryScope } from '../contracts/index.js';
import { DEFAULT_EMBED_DIM } from '../contracts/embed.js';
import { fuseHits, normalizeScores, type FusedHit } from './fuse.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';
import { usefulnessScores } from '../storage/usefulness.js';
import { EntityRepo } from '../storage/entities.js';
import { applyRerank, type RerankOpts } from './rerank.js';
// FEAT-429: the repo/project/agent hard-column WHERE-clause builder and the
// since numeric-range builder now derive from the shared filter-descriptor
// registry instead of hand-rolled closures — see
// src/contracts/filter-registry.ts.
import { applySqlColumnFilters, applySqlRangeFilters, mergeRepoAlias } from '../contracts/filter-registry.js';

export interface SearchFilters {
  type?: string[];
  /**
   * atom@2 repo/project consolidation (plan 20260709): UX-alias input only —
   * GET /search?repo=, POST /recall filters.repo, and the MCP tools still
   * accept it for back-compat, but it is folded into `project`'s OR-list at
   * the SQL boundary below (mergeRepoAlias), never queried as its own
   * `memories.repo` column. A caller that sends both gets the union.
   */
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
   *
   * FEAT-453 §3.3: combined with `as_of`, the intersection narrows to
   * fact-level validity — a memory only qualifies if the matched entity
   * link's effective window (clipped to the memory's own valid_from/
   * valid_to) covers `as_of`, even if the memory itself is still otherwise
   * "current." `entity` alone (no `as_of`) is unaffected — same as before
   * FEAT-453.
   */
  entity?: string;
}

/**
 * Astramem-retrieval-result@1 `ScoreExplanation.signals[name]` shape
 * (contracts/schemas/retrieval-result.v1.schema.json) — per-signal raw
 * score, effective weight, and this signal's contribution to the fused
 * score (`final`). `raw` is the true un-normalized value (e.g. the negated
 * SQLite bm25() score, the raw cosine similarity); `final` is
 * `normalized(raw) * weight`, i.e. this signal's actual share of `score`.
 */
export interface ScoreSignal {
  raw: number;
  weight: number;
  final: number;
}

/**
 * Astramem-retrieval-result@1 `ScoreExplanation` (ADR-005 debugging/trust
 * surface). `final` always equals the hit's top-level `score` — CONTRACT-
 * FREEZE §2 (astragenie/memory#759) requires this invariant regardless of
 * which signals happen to be present.
 */
export interface ScoreExplanation {
  final: number;
  signals: Record<string, ScoreSignal>;
}

export interface SearchHit {
  id: string;
  type: MemoryType;
  text: string;
  score: number;
  /**
   * Fusion-leg indicator: which candidate-gathering stage(s) produced this
   * id (FTS5 BM25, vector search, or both) — an INTERNAL local-only
   * debugging field distinct from the canonical wire contract's `source`
   * (which means memory *provenance*, see `capture_source` below). Never
   * renamed here to avoid breaking existing consumers (CLI table, dashboard
   * debug page, tests) that predate the retrieval@1 contract adoption.
   */
  source: 'fts' | 'vec' | 'both';
  /** ADR-009 memory scope (private|team|org). Always present — `memories.scope` is NOT NULL. */
  scope: MemoryScope;
  /** `memories.importance` [0,1]. Always present — NOT NULL DEFAULT 0.5. */
  importance: number;
  /** `memories.confidence` [0,1]. Always present — NOT NULL DEFAULT 0.5. */
  confidence: number;
  /** `memories.created_at`, ISO-8601 (wire-ready — contracts/schemas/retrieval-result.v1.schema.json `created_at` is `format: date-time`). */
  created_at: string;
  /**
   * `memories.capture_source` (migration 024) — CONTRACT-FREEZE §1 maps
   * this to the canonical wire `source` field ("origin of the memory").
   * Named `capture_source` here, not `source`, to avoid colliding with the
   * pre-existing fusion-leg `source` field above; a route/wire-serialization
   * layer is the natural place to rename it to `source` on the JSON
   * response, which is out of this change's scope (contracts/ + src/search/
   * only — see astragenie/astramem-local PR for retrieval@1 adoption).
   * Omitted (not `null`) when the memory has no capture_source, since the
   * canonical schema's `source` is `{type: "string"}` with no null variant.
   */
  capture_source?: string;
  /**
   * ScoreExplanation (ADR-005/CONTRACT-FREEZE §2) — ALWAYS present as of
   * the retrieval@1 adoption (2026-07-13), not just when reranked. Base
   * signals are bm25/cosine (only when that leg produced a candidate for
   * this id)/importance/freshness/usefulness, plus entity_bonus/agent_bonus
   * when their weight (zeta/eta) is active. Gains a `cross_encoder` signal
   * (merged in, not replacing the base signals) when the rerank stage
   * (FEAT-452) actually scored this hit — see `reranked`/`rerank_score`
   * below.
   */
  explanation: ScoreExplanation;
  /**
   * FEAT-452: present + `reranked: true` only when the cross-encoder rerank
   * stage (issue #26, src/search/rerank.ts) actually scored this hit this
   * call. `score` above always stays the original fused score — it is never
   * overwritten by rerank; `rerank_score`/`explanation.signals.cross_encoder`
   * carry the cross-encoder's own verdict as a distinct, additive signal
   * (ADR-005 `ScoreExplanation.signals` shape — see
   * docs/runbooks/cross-encoder-rerank.md). Absent (not just `false`) when
   * rerank is disabled (the default), when this hit fell beyond
   * `opts.rerank.topK`, or when the whole-call timeout/error fallback fired.
   */
  reranked?: true;
  rerank_score?: number;
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
  /**
   * Optional post-fusion cross-encoder rerank stage (issue #26, ADR-005).
   * `undefined` (the default — see config.crossEncoder.enabled / resolveRerankOpts
   * in rerank.ts) means the stage is never invoked and the SearchHit[] path is
   * byte-identical to pre-rerank behavior. When present, only the debug:false
   * path is affected — SearchDebugHit[] (debug:true) always reflects the raw
   * fusion breakdown, never reranked, since its purpose is explaining fusion.
   */
  rerank?: RerankOpts;
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
  //
  // FEAT-453 §3.3 composition point B: when `as_of` is ALSO present, the
  // intersection is time-aware (memoryIdsForEntitiesAsOf) — a memory whose
  // matched fact link's effective window (§3.1, clipped to the parent
  // memory's own window) doesn't cover `as_of` is excluded from selection,
  // even though the same memory still passes the ordinary memory-level
  // `validityFilterClause(as_of)` applied later. Without `entity`, `as_of`
  // alone never reaches this step at all — §3.2's point A (plain temporal,
  // no entity filter) is projection-only and leaves memory selection
  // unchanged, so it is not implemented here.
  let filteredFtsHits = ftsHits;
  let filteredVecHits = vecHits;
  if (filters.entity !== undefined) {
    const entityRepo = new EntityRepo(db);
    const entityIds = entityRepo.resolveIds(filters.entity);
    const linkedIds = filters.as_of !== undefined
      ? entityRepo.memoryIdsForEntitiesAsOf(entityIds, filters.as_of)
      : entityRepo.memoryIdsForEntities(entityIds);
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
  // FEAT-429: project/agent hard-column filters (single value -> `col = ?`,
  // list -> `col IN (...)`, OR-semantics like `type[]`, empty list -> no
  // constraint) and the since numeric lower-bound filter (`created_at >= ?`)
  // are derived from the registry's `applySqlColumnFilters`/
  // `applySqlRangeFilters` instead of hand-rolled clauses. `agent` is only
  // handed in when `agentMode === 'filter'` (FEAT-426: the default,
  // byte-identical to pre-FEAT-426 behavior) — in 'boost' mode it is omitted
  // here entirely so no SQL filter is applied; non-matches stay in the
  // result set and are instead re-ranked via the η agentBonus computed above.
  const registrySqlInput: Record<string, unknown> = {};
  // atom@2 repo/project consolidation (plan 20260709): `repo` is a UX-alias
  // input (see SearchFilters.repo doc) — it is never its own SQL column
  // anymore. Fold it into `project`'s OR-list here, the single point every
  // surface (GET /search, POST /recall, MCP search_memory/recall_memory)
  // funnels through, before the registry builds the `project = ?`/`project
  // IN (...)` clause below.
  const mergedProject = mergeRepoAlias(filters.repo, filters.project);
  if (mergedProject !== undefined) registrySqlInput.project = mergedProject;
  if (filters.agent !== undefined && agentMode === 'filter') registrySqlInput.agent = filters.agent;
  if (filters.since !== undefined) registrySqlInput.since = filters.since;
  const { clauses: registryClauses, params: registryParams } = applySqlColumnFilters(registrySqlInput);
  filterClauses.push(...registryClauses);
  filterParams.push(...registryParams);
  const { clauses: rangeClauses, params: rangeParams } = applySqlRangeFilters(registrySqlInput);
  filterClauses.push(...rangeClauses);
  filterParams.push(...rangeParams);

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
  // retrieval@1 adoption (2026-07-13, CONTRACT-FREEZE astragenie/memory#759):
  // scope/importance/confidence/created_at/capture_source added to the
  // SELECT so the wire-facing SearchHit below can populate the canonical
  // optional fields from real columns instead of projecting them away.
  const sql = `SELECT id, type, text, scope, importance, confidence, created_at, capture_source FROM memories WHERE id IN (${idPlaceholders}) AND ${validityClause}${whereFilter}`;
  const memRows = db.prepare(sql).all(...fusedIds, ...validityParams, ...filterParams) as Array<{
    id: string;
    type: MemoryType;
    text: string;
    scope: MemoryScope;
    importance: number;
    confidence: number;
    created_at: number;
    capture_source: string | null;
  }>;

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
  //
  // When the rerank stage is enabled (opts.rerank), build up to topK
  // candidates (not just `limit`) so the reranker has the full candidate
  // window it's configured for, then rerank + truncate to `limit` below.
  // When disabled (the default), buildLimit === limit — byte-identical to
  // pre-rerank behavior.
  const buildLimit = opts.rerank ? Math.max(limit, opts.rerank.topK) : limit;

  // retrieval@1 adoption (2026-07-13, CONTRACT-FREEZE astragenie/memory#759):
  // ScoreExplanation is now built for every hit, not just debug:true — this
  // is a SEPARATE computation from the 6a debug block above (deliberately
  // not shared/refactored out of it) so debug:true's existing output and
  // tests/search/search-debug.test.ts are byte-identical to before this
  // change; only this main (non-debug) path changes shape.
  const bm25RawForExplain = new Map(filteredFtsHits.map(h => [h.id, -h.bm25]));
  const normBm25Arr3 = normalizeScores(filteredFtsHits.map(h => -h.bm25));
  const normBm25ForExplain = new Map(filteredFtsHits.map((h, i) => [h.id, normBm25Arr3[i] ?? 0]));
  const cosineRawForExplain = new Map(filteredVecHits.map(h => [h.id, h.cosine]));
  const normCosineArr3 = normalizeScores(filteredVecHits.map(h => h.cosine));
  const normCosineForExplain = new Map(filteredVecHits.map((h, i) => [h.id, normCosineArr3[i] ?? 0]));
  const explainWeightSumRaw =
    weights.alpha + weights.beta + weights.gamma + weights.delta + (weights.epsilon ?? 0) + zeta + eta;
  const explainWeightSum = explainWeightSumRaw === 0 ? 1 : explainWeightSumRaw;
  const explainWeights = {
    bm25: weights.alpha / explainWeightSum,
    cosine: weights.beta / explainWeightSum,
    importance: weights.gamma / explainWeightSum,
    freshness: weights.delta / explainWeightSum,
    usefulness: (weights.epsilon ?? 0) / explainWeightSum,
    entity_bonus: zeta / explainWeightSum,
    agent_bonus: eta / explainWeightSum,
  };

  function buildExplanation(id: string, score: number, importance: number, createdAtMs: number): ScoreExplanation {
    const ageDays = (nowMs - createdAtMs) / (24 * 60 * 60 * 1000);
    const freshness = Math.min(1, Math.exp(-ageDays / 30));
    const signals: Record<string, ScoreSignal> = {};
    if (bm25RawForExplain.has(id)) {
      signals.bm25 = { raw: bm25RawForExplain.get(id)!, weight: explainWeights.bm25, final: (normBm25ForExplain.get(id) ?? 0) * explainWeights.bm25 };
    }
    if (cosineRawForExplain.has(id)) {
      signals.cosine = { raw: cosineRawForExplain.get(id)!, weight: explainWeights.cosine, final: (normCosineForExplain.get(id) ?? 0) * explainWeights.cosine };
    }
    signals.importance = { raw: importance, weight: explainWeights.importance, final: importance * explainWeights.importance };
    signals.freshness = { raw: freshness, weight: explainWeights.freshness, final: freshness * explainWeights.freshness };
    const usefulnessRaw = usefulness.get(id) ?? 0.5;
    signals.usefulness = { raw: usefulnessRaw, weight: explainWeights.usefulness, final: usefulnessRaw * explainWeights.usefulness };
    if (entityBonus) {
      const raw = entityBonus.get(id) ?? 0;
      signals.entity_bonus = { raw, weight: explainWeights.entity_bonus, final: raw * explainWeights.entity_bonus };
    }
    if (agentBonus) {
      const raw = agentBonus.get(id) ?? 0;
      signals.agent_bonus = { raw, weight: explainWeights.agent_bonus, final: raw * explainWeights.agent_bonus };
    }
    // final MUST equal the hit's top-level score (CONTRACT-FREEZE §2), even
    // though usefulness/entity_bonus/agent_bonus above already account for
    // it — this is not a re-derivation, `score` is the source of truth.
    return { final: score, signals };
  }

  const results: SearchHit[] = [];
  for (const hit of fused) {
    const mem = memMap.get(hit.id);
    if (!mem) continue;  // filtered out
    results.push({
      id: hit.id,
      type: mem.type,
      text: mem.text,
      score: hit.score,
      source: hit.source,
      scope: mem.scope,
      importance: mem.importance,
      confidence: mem.confidence,
      created_at: new Date(mem.created_at).toISOString(),
      ...(mem.capture_source !== null ? { capture_source: mem.capture_source } : {}),
      explanation: buildExplanation(hit.id, hit.score, mem.importance, mem.created_at),
    });
    if (results.length >= buildLimit) break;
  }

  if (opts.rerank) {
    const reranked = await applyRerank(query, results, opts.rerank);
    // applyRerank (src/search/rerank.ts) is a generic, independently-tested
    // utility that OVERWRITES `explanation` with just `{signals:
    // {cross_encoder}}}` — by design, so its own unit tests
    // (tests/search/rerank.test.ts) can exercise it against bare
    // `{id,text,score}` candidates with no pre-existing explanation. Here,
    // where every hit already carries a real base ScoreExplanation, merge
    // the cross_encoder signal IN rather than let it clobber the base
    // signals — `final` stays the fused `score` (rerank never changes it).
    const merged = reranked.map(hit => {
      if (!hit.reranked) return hit;
      const crossEncoder = hit.explanation!.signals.cross_encoder!;
      const base = results.find(r => r.id === hit.id)!;
      return {
        ...hit,
        explanation: {
          final: hit.score,
          signals: { ...base.explanation.signals, cross_encoder: crossEncoder },
        },
      };
    });
    return merged.slice(0, limit);
  }

  return results;
}
