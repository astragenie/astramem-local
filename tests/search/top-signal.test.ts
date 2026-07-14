// FEAT-500: `top_signal` — argmax of ScoreExplanation.signals by `.final`,
// deterministic alphabetical tie-break. Per-signal scores themselves
// (ScoreExplanation/buildExplanation) shipped 2026-07-13 — this only adds the
// derived argmax field on top, unit-tested here as a pure function plus one
// real search() integration check that it reaches SearchHit.explanation.

import { describe, it, expect } from 'vitest';
import { computeTopSignal, search, makeFakeVec, type ScoreSignal } from '../../src/search/search.js';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { MockCrossEncoderProvider, type RerankOpts } from '../../src/search/rerank.js';
import { defaultConfig } from '../../src/config/config.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

function sig(final: number): ScoreSignal {
  return { raw: final, weight: 1, final };
}

describe('computeTopSignal (FEAT-500 argmax)', () => {
  it('picks the signal with the highest .final', () => {
    const top = computeTopSignal({
      bm25: sig(0.1),
      cosine: sig(0.5),
      importance: sig(0.2),
    });
    expect(top).toBe('cosine');
  });

  it('single-signal map: that signal wins trivially', () => {
    expect(computeTopSignal({ freshness: sig(0.3) })).toBe('freshness');
  });

  it('empty signals map: undefined (never happens in practice, but stays honest)', () => {
    expect(computeTopSignal({})).toBeUndefined();
  });

  it('deterministic tie-break: equal .final resolves alphabetically regardless of key insertion order', () => {
    const a = computeTopSignal({ usefulness: sig(0.4), bm25: sig(0.4), cosine: sig(0.4) });
    const b = computeTopSignal({ cosine: sig(0.4), bm25: sig(0.4), usefulness: sig(0.4) });
    expect(a).toBe('bm25');
    expect(b).toBe('bm25'); // same winner regardless of object key order
  });

  it('negative and zero finals are compared correctly (not just truthy)', () => {
    const top = computeTopSignal({ entity_bonus: sig(0), agent_bonus: sig(-0.1), freshness: sig(0.01) });
    expect(top).toBe('freshness');
  });

  it('all-negative finals: the least-negative one wins', () => {
    const top = computeTopSignal({ a: sig(-0.5), b: sig(-0.1), c: sig(-0.9) });
    expect(top).toBe('b');
  });
});

// ── Integration: top_signal reaches SearchHit.explanation from a real search() call ──

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

async function seedWithVec(db: DB, text: string, hash: string): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
  const vecStore = new SqliteVecStore(db, fakeEmbed.dim);
  const [vec] = await fakeEmbed.embed([text]);
  await vecStore.upsert(id, vec as Float32Array);
  return id;
}

describe('search() → SearchHit.explanation.top_signal (FEAT-500)', () => {
  it('every hit carries a top_signal that is a real key present in its own signals map', async () => {
    const db = setupDb();
    await seedWithVec(db, 'top signal integration check sqlite hybrid search', 'ts-1');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'ts-2');

    const hits = await search('top signal integration check sqlite hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.explanation.top_signal).toBeDefined();
      expect(hit.explanation.signals[hit.explanation.top_signal!]).toBeDefined();
      // top_signal really must be the argmax, not just any present key.
      const expected = computeTopSignal(hit.explanation.signals);
      expect(hit.explanation.top_signal).toBe(expected);
    }
  });

  it('rerank stage: top_signal is recomputed post-merge, so cross_encoder can itself become the winner', async () => {
    const db = setupDb();
    const idA = await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'ts-rr-a');
    const idB = await seedWithVec(db, 'completely unrelated banana bread recipe', 'ts-rr-b');

    // Cross-encoder scores every candidate near-1 — guaranteed to dominate
    // the small base fusion signals for at least one hit.
    const rerank: RerankOpts = { topK: 50, timeoutMs: 300, provider: new MockCrossEncoderProvider() };
    const hits = await search('sqlite-vec hybrid bm25 fusion search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, rerank,
    });
    expect(new Set(hits.map(h => h.id))).toEqual(new Set([idA, idB]));

    for (const hit of hits) {
      expect(hit.explanation.top_signal).toBeDefined();
      const expected = computeTopSignal(hit.explanation.signals);
      expect(hit.explanation.top_signal).toBe(expected);
      if (hit.reranked) {
        // cross_encoder is present post-merge — the recomputed argmax must
        // consider it, not just the pre-rerank base signals.
        expect('cross_encoder' in hit.explanation.signals).toBe(true);
      }
    }
  });
});
