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
import { fuseHits, type FusedHit } from './fuse.js';
import { SqliteVecStore } from '../vector/sqlite-vec.js';

export interface SearchFilters {
  type?: string[];
  repo?: string;
  project?: string;
  since?: number;  // epoch ms lower bound on created_at
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
  weights: { alpha: number; beta: number; gamma: number; delta: number };
  /** Multiplier used by vector search (cap to limit vector scan) */
  vecK?: number;
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
 * Deterministic fake vector for testing — 1024-dim seeded by text hash.
 * Exported so tests can call it directly without importing the EmbedProvider.
 */
export function makeFakeVec(text: string): Float32Array {
  const v = new Float32Array(1024);
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) & 0xffffffff;
  }
  for (let i = 0; i < 1024; i++) {
    v[i] = Math.sin(hash * 0.001 + i * 0.01);
  }
  return v;
}

export async function search(
  query: string,
  filters: SearchFilters,
  limit: number,
  opts: SearchOpts
): Promise<SearchHit[]> {
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
    const vecStore = new SqliteVecStore(db);
    // Pass empty filter to vec adapter — post-fusion filters applied below
    const raw = await vecStore.search(queryVec, vecK);
    vecHits.push(...raw.map(h => ({ id: h.id, cosine: h.score })));
  } catch {
    // Vector search unavailable (no rows, no provider) — FTS-only mode
  }

  // 3. Load meta for all candidate ids (importance + created_at for freshness)
  const allIds = new Set([...ftsHits.map(h => h.id), ...vecHits.map(h => h.id)]);
  if (allIds.size === 0) return [];

  const placeholders = Array.from(allIds).map(() => '?').join(',');
  const metaRows = db.prepare(
    `SELECT id, importance, created_at FROM memories WHERE id IN (${placeholders})`
  ).all(...allIds) as Array<{ id: string; importance: number; created_at: number }>;

  const metaMap = new Map(metaRows.map(r => [r.id, { importance: r.importance, created_at: r.created_at }]));

  // 4. Fuse
  const fused = fuseHits(ftsHits, vecHits, metaMap, weights, Date.now());

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
  if (filters.project !== undefined) {
    filterClauses.push('project = ?');
    filterParams.push(filters.project);
  }
  if (filters.since !== undefined) {
    filterClauses.push('created_at >= ?');
    filterParams.push(filters.since);
  }

  // Fetch full memory records in one query using IN clause
  const fusedIds = fused.map(h => h.id);
  const idPlaceholders = fusedIds.map(() => '?').join(',');
  const whereFilter = filterClauses.length > 0 ? ` AND ${filterClauses.join(' AND ')}` : '';
  const sql = `SELECT id, type, text FROM memories WHERE id IN (${idPlaceholders})${whereFilter}`;
  const memRows = db.prepare(sql).all(...fusedIds, ...filterParams) as Array<{ id: string; type: MemoryType; text: string }>;

  const memMap = new Map(memRows.map(r => [r.id, r]));

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
