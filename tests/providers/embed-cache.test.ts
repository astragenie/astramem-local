import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import type { DB } from '../../src/storage/db.js';
import type { EmbedProvider, EmbedHealth } from '../../src/contracts/embed.js';
import { CachingEmbedProvider } from '../../src/providers/embed/cache.js';
import { getCacheStats } from '../../src/storage/embed-cache.js';

function makeVec(seed: number, dim = 4): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = seed + i * 0.1;
  return v;
}

/** Fake inner provider — counts real embed() calls and the texts sent, so
 * the "zero Ollama calls on re-run" AC is provable rather than asserted. */
function makeCountingInner(dim = 4): EmbedProvider & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    name: 'ollama' as const,
    model: 'test-embed-model',
    dim,
    calls,
    async embed(texts: string[]): Promise<Float32Array[]> {
      calls.push([...texts]);
      return texts.map((t) => makeVec(t.length, dim));
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-embed-model', dim };
    },
  };
}

describe('CachingEmbedProvider', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db, 4);
  });

  it('issues one inner call for an all-miss batch, then zero inner calls for the same texts again', async () => {
    const inner = makeCountingInner();
    const cache = new CachingEmbedProvider(inner, db);

    const texts = ['alpha memory text', 'beta memory text', 'gamma memory text'];
    const first = await cache.embed(texts);
    expect(inner.calls.length).toBe(1);
    expect(inner.calls[0]).toEqual(texts);
    expect(first).toHaveLength(3);

    // Re-run over the SAME (unchanged) content — this is the AC: zero
    // Ollama/inner embed calls.
    const second = await cache.embed(texts);
    expect(inner.calls.length).toBe(1); // still just the one call from before
    expect(second).toEqual(first);
  });

  it('batches only the miss set on a partial-hit call (batch-on-miss)', async () => {
    const inner = makeCountingInner();
    const cache = new CachingEmbedProvider(inner, db);

    await cache.embed(['cached one', 'cached two']);
    expect(inner.calls.length).toBe(1);

    await cache.embed(['cached one', 'brand new text', 'cached two']);
    expect(inner.calls.length).toBe(2);
    expect(inner.calls[1]).toEqual(['brand new text']); // ONE call, only the miss
  });

  it('resolves a same-batch duplicate from the single inner call without a second call', async () => {
    const inner = makeCountingInner();
    const cache = new CachingEmbedProvider(inner, db);

    const [a, b] = await cache.embed(['same text', 'same text']);
    expect(inner.calls.length).toBe(1);
    expect(inner.calls[0]).toEqual(['same text']);
    expect(a).toEqual(b);
  });

  it('keys the cache on (hash, model, dim) — a different dim never returns a wrong-length vector', async () => {
    const innerA = makeCountingInner(4);
    const innerB = makeCountingInner(8);
    const cacheA = new CachingEmbedProvider(innerA, db);
    const cacheB = new CachingEmbedProvider(innerB, db);

    const [vecA] = await cacheA.embed(['same content, different dim']);
    expect(vecA.length).toBe(4);
    expect(innerA.calls.length).toBe(1);

    // Same model name, same text, but a DIFFERENT configured dim — must be a
    // real miss (a fresh inner.embed call), never a 4-length hit served back
    // as if it were 8-length.
    const [vecB] = await cacheB.embed(['same content, different dim']);
    expect(vecB.length).toBe(8);
    expect(innerB.calls.length).toBe(1);
  });

  it('records cumulative hit/miss counters visible to the doctor stat', async () => {
    const inner = makeCountingInner();
    const cache = new CachingEmbedProvider(inner, db);

    await cache.embed(['one', 'two']); // 2 misses
    await cache.embed(['one', 'three']); // 1 hit, 1 miss

    const stats = getCacheStats(db);
    expect(stats.misses).toBe(3);
    expect(stats.hits).toBe(1);
  });

  it('evicts the least-recently-used rows once maxEntries is exceeded', async () => {
    const inner = makeCountingInner();
    const cache = new CachingEmbedProvider(inner, db, { maxEntries: 2 });

    await cache.embed(['first']);
    await cache.embed(['second']);
    await cache.embed(['third']); // pushes total to 3, over the cap of 2

    const { n } = db.prepare('SELECT COUNT(*) AS n FROM embed_cache').get() as { n: number };
    expect(n).toBe(2);

    // 'first' should have been evicted (oldest last_used_at) — re-embedding
    // it must be a real miss again.
    const before = inner.calls.length;
    await cache.embed(['first']);
    expect(inner.calls.length).toBe(before + 1);
  });

  it('delegates health() to the inner provider unchanged', async () => {
    const inner = makeCountingInner();
    const healthSpy = vi.spyOn(inner, 'health');
    const cache = new CachingEmbedProvider(inner, db);

    const result = await cache.health();
    expect(healthSpy).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });

  it('mirrors name/model/dim/queryPrefix from the inner provider', () => {
    const inner = makeCountingInner();
    const cache = new CachingEmbedProvider(inner, db);
    expect(cache.name).toBe(inner.name);
    expect(cache.model).toBe(inner.model);
    expect(cache.dim).toBe(inner.dim);
  });
});
