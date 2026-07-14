/**
 * Persistence for the content-hash embedding cache (FEAT-492, migration
 * 042). Backs `CachingEmbedProvider` (src/providers/embed/cache.ts) — this
 * module is pure SQLite access (batched lookup/insert/evict + cumulative
 * hit/miss counters), no provider or hashing logic of its own.
 *
 * Key = (content_hash, model, dim). `dim` rides alongside `model` (not
 * inferred from it) because a provider's *configured* output dim can change
 * independently of its model name — Azure's `dimensions` truncation param
 * is the concrete case — and a cache keyed on (hash, model) alone would then
 * serve a wrong-length vector for the caller's current `embed.dim`.
 */

import type { DB } from './db.js';

export interface EmbedCacheEntry {
  contentHash: string;
  vector: Float32Array;
}

/**
 * Batched lookup: returns a Map from content_hash -> cached vector for every
 * hash in `hashes` that has a live row for `model`/`dim`. Hashes with no
 * cache row are simply absent from the returned map (the caller's miss set
 * is `hashes` minus `map.keys()`) — this function never distinguishes "no
 * row" from an error; a query failure throws and the caller (CachingEmbedProvider)
 * treats the whole batch as a miss rather than serving partial/uncertain data.
 *
 * Also bumps `last_used_at` on every hit (single UPDATE, same statement
 * batch) so the LRU eviction order in `evictExcess` reflects real recency,
 * not just insertion order.
 */
export function getCachedEmbeddings(
  db: DB,
  hashes: string[],
  model: string,
  dim: number,
): Map<string, Float32Array> {
  const result = new Map<string, Float32Array>();
  if (hashes.length === 0) return result;

  // better-sqlite3 has no array-bind IN() support — build the placeholder
  // list explicitly. `hashes` are sha256 hex digests (our own contentHash
  // output, never raw user text), so this is safe string interpolation of a
  // fixed-count `?` placeholder list, not of the values themselves.
  const placeholders = hashes.map(() => '?').join(',');
  const rows = db
    .prepare(`
      SELECT content_hash AS contentHash, vector
      FROM embed_cache
      WHERE model = ? AND dim = ? AND content_hash IN (${placeholders})
    `)
    .all(model, dim, ...hashes) as Array<{ contentHash: string; vector: Buffer }>;

  if (rows.length === 0) return result;

  const now = Date.now();
  const touch = db.prepare(
    'UPDATE embed_cache SET last_used_at = ? WHERE content_hash = ? AND model = ? AND dim = ?',
  );
  const touchMany = db.transaction((hitHashes: string[]) => {
    for (const h of hitHashes) touch.run(now, h, model, dim);
  });

  for (const row of rows) {
    // vector BLOB is a raw Float32Array byte buffer (see putCachedEmbeddings) —
    // reinterpret without copying the underlying bytes twice.
    result.set(row.contentHash, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
  }
  touchMany(rows.map(r => r.contentHash));

  return result;
}

/** Batched insert-or-replace for newly-computed (miss-set) embeddings. No-op on an empty list. */
export function putCachedEmbeddings(db: DB, model: string, dim: number, entries: EmbedCacheEntry[]): void {
  if (entries.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO embed_cache (content_hash, model, dim, vector, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const insertMany = db.transaction((rows: EmbedCacheEntry[]) => {
    for (const e of rows) {
      const buf = Buffer.from(e.vector.buffer, e.vector.byteOffset, e.vector.byteLength);
      stmt.run(e.contentHash, model, dim, buf, now, now);
    }
  });
  insertMany(entries);
}

/**
 * Evict the oldest-by-`last_used_at` rows once the table exceeds `maxEntries`.
 * Called after every insert batch rather than on a timer — cheap (COUNT(*) is
 * indexed via the table's own rowcount, and the DELETE only runs when the cap
 * is actually exceeded) and keeps the table bounded without a background job.
 */
export function evictExcess(db: DB, maxEntries: number): void {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM embed_cache').get() as { n: number };
  const excess = n - maxEntries;
  if (excess <= 0) return;
  db.prepare(`
    DELETE FROM embed_cache
    WHERE rowid IN (
      SELECT rowid FROM embed_cache ORDER BY last_used_at ASC LIMIT ?
    )
  `).run(excess);
}

/** Bump the cumulative hit/miss counters (doctor "Embed cache hit rate" stat). One UPDATE per embed() call, not per item. */
export function recordCacheStats(db: DB, hits: number, misses: number): void {
  if (hits === 0 && misses === 0) return;
  db.prepare(`
    UPDATE embed_cache_stats
    SET hits = hits + ?, misses = misses + ?, updated_at = ?
    WHERE id = 1
  `).run(hits, misses, Date.now());
}

export interface EmbedCacheStats {
  hits: number;
  misses: number;
}

/** Read the cumulative hit/miss counters. Returns zeros if the singleton row is somehow missing (pre-migration DB, defensive only). */
export function getCacheStats(db: DB): EmbedCacheStats {
  const row = db.prepare('SELECT hits, misses FROM embed_cache_stats WHERE id = 1').get() as
    | { hits: number; misses: number }
    | undefined;
  return row ?? { hits: 0, misses: 0 };
}
