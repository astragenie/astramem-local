/**
 * Content-hash embedding cache (FEAT-492) — decorator over an inner
 * `EmbedProvider`, ported from cloud's `CachingEmbeddingProvider.cs`
 * pattern. Local flavor: plain SQLite table (migration 043,
 * src/storage/embed-cache.ts) instead of an external cache dependency —
 * Ollama's cost here is wall-clock time on the user's own machine, not
 * money, but re-embedding unchanged content on every distill/reembed run is
 * still pure waste.
 *
 * DOCUMENT-ROLE ONLY — do not wrap the shared `providers.embed` instance
 * that `src/search/search.ts`, the MCP/HTTP search routes, and the doctor
 * embed probe all read from. Wire this ONLY at the call sites that embed
 * content for storage (src/pipeline/handlers/distill.ts,
 * distill-events.ts's embedAndIndex, and reembed.ts) — see
 * src/cli/serve.ts's `extCtx.providers` construction, which builds a
 * SEPARATE `{ ...providers, embed: cachedEmbed }` object for the worker
 * context while `providers.embed` (raw, uncached) keeps flowing to
 * `buildApp` (query-role search routes) and the health-check probes
 * unchanged.
 *
 * Why the split instead of caching at the shared provider (arch review
 * 2026-07-14): `resolveEmbedQueryPrefix` (src/contracts/embed.ts) resolves
 * the query-side instruction prefix ONCE at provider-construction time
 * (src/providers/index.ts's buildEmbedProvider), but the prefix itself is
 * only ever *applied* to the text handed to `embed()` at exactly one call
 * site — search.ts's vector-embed call. A query embed is (a) never repeated
 * verbatim across requests, so caching it buys nothing, and (b) if it WERE
 * cached through the same table as document embeds, a document whose text
 * happened to start with the literal prefix string would collide with a
 * query cache entry — an unnecessary correctness dimension for zero
 * measured benefit. Scoping the wrapper to document call sites only avoids
 * both problems by construction, no prefix-sniffing required.
 */

import type { EmbedHealth, EmbedProvider } from '../../contracts/embed.js';
import type { DB } from '../../storage/db.js';
import { contentHash } from '../../storage/content-hash.js';
import { childLogger } from '../../log/logger.js';
import {
  getCachedEmbeddings,
  putCachedEmbeddings,
  evictExcess,
  recordCacheStats,
  type EmbedCacheEntry,
} from '../../storage/embed-cache.js';

/**
 * Row cap for `embed_cache`. Local corpora observed in production (see
 * migration 041's doc comment: ~18,863 active memories on one install) sit
 * comfortably under this with headroom for growth — chosen as a bound on
 * disk/row count, not a freshness policy (there is no TTL: the same content
 * hash + model + dim always produces the same vector, so a cache hit is
 * never stale). Overridable per-instance for tests.
 */
const DEFAULT_MAX_ENTRIES = 20_000;

export interface CachingEmbedProviderOpts {
  maxEntries?: number;
}

export class CachingEmbedProvider implements EmbedProvider {
  readonly name: EmbedProvider['name'];
  readonly model: string;
  readonly dim: number;
  readonly queryPrefix?: string;
  private readonly inner: EmbedProvider;
  private readonly db: DB;
  private readonly maxEntries: number;

  constructor(inner: EmbedProvider, db: DB, opts: CachingEmbedProviderOpts = {}) {
    this.inner = inner;
    this.db = db;
    this.name = inner.name;
    this.model = inner.model;
    this.dim = inner.dim;
    this.queryPrefix = inner.queryPrefix;
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const log = childLogger({ provider: this.name, model: this.model, component: 'embed-cache' });
    const hashes = texts.map((t) => contentHash(t));

    // Cache-read failure (disk full, DB locked, corrupt BLOB row, ...) must
    // never block a distill/reembed job from producing vectors — Ollama may
    // be perfectly healthy even though the cache table is not. Degrade to a
    // full miss (empty map) and fall through to inner.embed() for everything
    // rather than letting the exception propagate and lose the whole batch.
    let cached: Map<string, Float32Array>;
    try {
      cached = getCachedEmbeddings(this.db, hashes, this.model, this.dim);
    } catch (err) {
      log.error({ err, text_count: texts.length }, 'embed cache read failed — degrading to full miss (real embed call for all texts)');
      cached = new Map();
    }

    // Preserve input order in the result while embedding only the miss set
    // in ONE inner call (batch-on-miss, AC: "one real call for the miss
    // set"). `missIndices` maps each miss back to its position in `texts`/
    // `hashes` — needed because a duplicate text within the same batch
    // (same hash appearing twice) must resolve to the SAME vector without
    // being embedded twice.
    const results: (Float32Array | undefined)[] = new Array(texts.length);
    const missTexts: string[] = [];
    const missIndices: number[] = [];
    const missHashSeen = new Map<string, number>(); // hash -> first miss index into missTexts

    for (let i = 0; i < texts.length; i++) {
      const hash = hashes[i]!;
      const hit = cached.get(hash);
      if (hit) {
        results[i] = hit;
        continue;
      }
      const dupOf = missHashSeen.get(hash);
      if (dupOf !== undefined) {
        // Same content repeated within this batch, still uncached — resolved
        // below from the single embed call's output, not a second call.
        missIndices.push(i);
        continue;
      }
      missHashSeen.set(hash, missTexts.length);
      missTexts.push(texts[i]!);
      missIndices.push(i);
    }

    if (missTexts.length > 0) {
      const missVectors = await this.inner.embed(missTexts, signal);

      // Resolve every original index (including same-batch duplicates of an
      // uncached hash) from this one inner call's output.
      for (const i of missIndices) {
        const hash = hashes[i]!;
        const missTextIdx = missHashSeen.get(hash)!;
        const vec = missVectors[missTextIdx];
        if (!vec) {
          throw new Error(
            `CachingEmbedProvider: inner provider returned no vector for miss index ${missTextIdx} (hash ${hash})`,
          );
        }
        results[i] = vec;
      }

      // Cache-write failure here must never fail the caller: the vectors in
      // `results` are already correctly computed by the (successful) inner
      // embed() call above. Losing the cache write only costs a repeat
      // Ollama call next run — a performance regression, not a correctness
      // one — so log loudly and keep going rather than discarding already-
      // computed work.
      try {
        const newEntries: EmbedCacheEntry[] = [];
        for (const [hash, idx] of missHashSeen) {
          const vec = missVectors[idx];
          if (vec) newEntries.push({ contentHash: hash, vector: vec });
        }
        putCachedEmbeddings(this.db, this.model, this.dim, newEntries);
        evictExcess(this.db, this.maxEntries);
      } catch (err) {
        log.error({ err, miss_count: missHashSeen.size }, 'embed cache write failed — returning freshly-computed vectors uncached');
      }
    }

    try {
      const hitCount = texts.length - missHashSeen.size;
      recordCacheStats(this.db, hitCount, missHashSeen.size);
    } catch (err) {
      log.error({ err }, 'embed cache stats update failed (non-fatal)');
    }

    return results as Float32Array[];
  }

  async health(): Promise<EmbedHealth> {
    return this.inner.health();
  }
}
