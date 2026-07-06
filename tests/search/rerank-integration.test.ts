// Issue #26 / ADR-005 — cross-encoder rerank stage wired into search().
//
// AC: rerank:undefined (the default, config.crossEncoder.enabled: false) is
//     identical to pre-rerank search() behavior (same ranked id order).
// AC: rerank enabled invokes the provider with the fused top-K candidates and
//     reorders the result according to its scores.
// AC: rerank respects the caller's `limit` even when topK is larger.
// AC: debug:true never invokes the rerank provider — the fusion breakdown is
//     always pre-rerank, by construction (search.ts returns from the debug
//     branch before the rerank stage is ever reached).

import { describe, it, expect, vi } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import { MockCrossEncoderProvider, resolveRerankOpts, type RerankOpts, type CrossEncoderProvider } from '../../src/search/rerank.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

function seed(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

async function seedWithVec(db: DB, text: string, hash: string): Promise<string> {
  const id = seed(db, text, hash);
  const vecStore = new SqliteVecStore(db, fakeEmbed.dim);
  const [vec] = await fakeEmbed.embed([text]);
  await vecStore.upsert(id, vec as Float32Array);
  return id;
}

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

describe('search() + cross-encoder rerank stage (issue #26)', () => {
  it('rerank omitted: same ranked id order as an explicit rerank:undefined call', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'r-1');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'r-2');

    const withoutRerank = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const withUndefinedRerank = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, rerank: undefined,
    });
    // Freshness is computed from Date.now() at call time, so two sequential
    // calls can differ by a sub-microsecond amount in score — compare ranked
    // id order (the behavior that matters) and scores with high-precision
    // tolerance, not bit-exact equality.
    expect(withUndefinedRerank.map(h => h.id)).toEqual(withoutRerank.map(h => h.id));
    withUndefinedRerank.forEach((h, i) => expect(h.score).toBeCloseTo(withoutRerank[i]!.score, 6));
  });

  it('config.crossEncoder disabled (default) → resolveRerankOpts(config) is undefined end to end', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'r-3');

    const rerank = resolveRerankOpts(defaultConfig());
    expect(rerank).toBeUndefined();

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, rerank,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('rerank enabled: provider is invoked with the fused candidates and its scores reorder the result', async () => {
    const db = setupDb();
    const idA = await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'ri-a');
    const idB = await seedWithVec(db, 'completely unrelated banana bread recipe', 'ri-b');

    const spyScore = vi.fn(async (_query: string, candidates: { id: string }[]) => {
      // Deliberately invert whatever fused order search() hands us, so a
      // real reorder is provably driven by this provider's return value.
      const map = new Map<string, number>();
      candidates.forEach((c, i) => map.set(c.id, i)); // last candidate scores highest
      return map;
    });
    const provider: CrossEncoderProvider = { name: 'mock', score: spyScore };
    const rerank: RerankOpts = { topK: 50, timeoutMs: 300, provider };

    const baseline = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const reranked = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, rerank,
    });

    expect(spyScore).toHaveBeenCalledTimes(1);
    const [, calledCandidates] = spyScore.mock.calls[0]!;
    expect(new Set(calledCandidates.map(c => c.id))).toEqual(new Set([idA, idB]));

    // The provider inverted the fused order, so reranked's top hit must be
    // baseline's LAST hit.
    expect(reranked[0]!.id).toBe(baseline[baseline.length - 1]!.id);
  });

  it('rerank respects `limit` — result length never exceeds the caller-requested limit even when topK is larger', async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) {
      await seedWithVec(db, `sqlite hybrid search candidate number ${i}`, `lim-${i}`);
    }
    const rerank: RerankOpts = { topK: 50, timeoutMs: 300, provider: new MockCrossEncoderProvider() };
    const hits = await search('sqlite hybrid search', {}, 2, {
      db, embed: fakeEmbed, weights: defaultConfig().search, rerank,
    });
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('debug:true never invokes the rerank provider — fusion breakdown is always pre-rerank', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'dbg-1');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'dbg-2');

    const spyScore = vi.fn(async () => new Map<string, number>());
    const provider: CrossEncoderProvider = { name: 'mock', score: spyScore };
    const rerank: RerankOpts = { topK: 50, timeoutMs: 300, provider };

    await search('sqlite-vec hybrid bm25 fusion search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, rerank, debug: true,
    });

    expect(spyScore).not.toHaveBeenCalled();
  });
});
