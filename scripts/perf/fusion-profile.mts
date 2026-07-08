/**
 * Fusion micro-profile — times the FTS5 BM25 query, the sqlite-vec KNN
 * query, and the fuseHits() join separately against the persisted per-size
 * datadir (read directly, daemon NOT running — no HTTP/serialization
 * overhead in these numbers, deliberately, so they isolate the DB-layer
 * cost search.ts pays internally). No src/ changes: reuses the exact
 * exported functions search.ts itself calls (SqliteVecStore, fuseHits,
 * makeFakeVec, usefulnessScores) — this script just calls them directly and
 * wraps each in a timer, since search.ts has no built-in per-stage timing
 * hook to reuse (confirmed: no PERF/debug-timing flag exists there, only the
 * score-breakdown SearchDebugHit projection, which is not wall-clock timing).
 *
 * Run under real `node` (not `bun run`): this script opens the SQLite
 * datadir in-process via better-sqlite3-multiple-ciphers, which Bun's
 * runtime cannot load (same footgun CLAUDE.md warns about for the daemon
 * itself — "'better-sqlite3' is not yet supported in Bun"). It imports from
 * dist/ (build output), not src/, because plain `node` type-stripping does
 * not rewrite `.js` specifiers to `.ts` sources the way Bun's resolver does
 * — run `bun run build` first if dist/ is stale.
 *
 * Usage: node scripts/perf/fusion-profile.mts [--sizes 1000,10000,100000] [--iterations 30]
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../../dist/storage/db.js';
import { SqliteVecStore } from '../../dist/vector/sqlite-vec.js';
import { fuseHits } from '../../dist/search/fuse.js';
import { makeFakeVec } from '../../dist/search/search.js';
import { usefulnessScores } from '../../dist/storage/usefulness.js';
import { DEFAULT_EMBED_DIM } from '../../dist/contracts/embed.js';
import { summarize, type LatencyStats } from './lib/stats.ts';
import { BENCH_QUERIES } from './lib/corpus.ts';
import type { PerfManifest } from './seed.mts';

const args = process.argv.slice(2);
const get = (flag: string): string | undefined => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
const sizes = (get('--sizes') ?? '1000,10000,100000').split(',').map(Number);
const iterations = Number(get('--iterations') ?? '30');

const PERF_DATA_ROOT = join('.eval-data', 'perf');
const VEC_K = 50; // matches search()'s default vecK = max(limit*4, 50) for limit<=12

function escapeFtsQuery(q: string): string {
  return q.trim().split(/\s+/).map(t => `"${t.replace(/"/g, '""')}"`).join(' ');
}

export interface FusionProfileResult {
  n: number;
  iterations: number;
  fts: LatencyStats;
  vec: LatencyStats;
  fusion: LatencyStats;
  measuredAt: string;
}

async function profileSize(n: number): Promise<FusionProfileResult | null> {
  const dir = join(PERF_DATA_ROOT, String(n));
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    console.warn(`[${n}] no manifest at ${manifestPath} — run seed.mts first. Skipping.`);
    return null;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PerfManifest;
  const dbPath = join(dir, 'datadir', 'memory.sqlite');
  const db = openDb(dbPath);
  const vecStore = new SqliteVecStore(db, DEFAULT_EMBED_DIM);

  console.log(`\n=== Fusion micro-profile: corpus size ${manifest.n} ===`);

  const ftsMs: number[] = [];
  const vecMs: number[] = [];
  const fusionMs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const q = BENCH_QUERIES[i % BENCH_QUERIES.length]!;
    const ftsQuery = escapeFtsQuery(q);

    const t0 = performance.now();
    const ftsHits = db.prepare(`
      SELECT m.id, bm25(memories_fts) AS bm25
      FROM memories_fts
      JOIN memories m ON m.rowid = memories_fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY bm25
      LIMIT ?
    `).all(ftsQuery, VEC_K) as Array<{ id: string; bm25: number }>;
    ftsMs.push(performance.now() - t0);

    const t1 = performance.now();
    const queryVec = makeFakeVec(q, DEFAULT_EMBED_DIM);
    const vecHitsRaw = await vecStore.search(queryVec, VEC_K);
    vecMs.push(performance.now() - t1);
    const vecHits = vecHitsRaw.map(h => ({ id: h.id, cosine: h.score }));

    const allIds = new Set([...ftsHits.map(h => h.id), ...vecHits.map(h => h.id)]);
    const placeholders = Array.from(allIds).map(() => '?').join(',');
    const metaRows = allIds.size > 0
      ? db.prepare(`SELECT id, importance, created_at FROM memories WHERE id IN (${placeholders})`).all(...allIds) as Array<{ id: string; importance: number; created_at: number }>
      : [];
    const metaMap = new Map(metaRows.map(r => [r.id, { importance: r.importance, created_at: r.created_at }]));

    const t2 = performance.now();
    const usefulness = usefulnessScores(db, Array.from(allIds));
    const weights = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1, epsilon: 0.1, zeta: 0, eta: 0 };
    fuseHits(ftsHits, vecHits, metaMap, weights, Date.now(), undefined, usefulness);
    fusionMs.push(performance.now() - t2);
  }

  db.close();

  const result: FusionProfileResult = {
    n: manifest.n,
    iterations,
    fts: summarize(ftsMs),
    vec: summarize(vecMs),
    fusion: summarize(fusionMs),
    measuredAt: new Date().toISOString(),
  };
  console.log(`  FTS    p50=${result.fts.p50.toFixed(3)}ms p95=${result.fts.p95.toFixed(3)}ms max=${result.fts.max.toFixed(3)}ms`);
  console.log(`  VEC    p50=${result.vec.p50.toFixed(3)}ms p95=${result.vec.p95.toFixed(3)}ms max=${result.vec.max.toFixed(3)}ms`);
  console.log(`  FUSION p50=${result.fusion.p50.toFixed(3)}ms p95=${result.fusion.p95.toFixed(3)}ms max=${result.fusion.max.toFixed(3)}ms`);

  writeFileSync(join(dir, 'fusion-profile.json'), JSON.stringify(result, null, 2));
  return result;
}

for (const size of sizes) {
  await profileSize(size);
}
