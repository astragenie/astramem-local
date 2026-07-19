// FEAT-550 — query rewrite/expansion wired into search() (src/search/query-rewrite.ts).
//
// AC-1: queryRewrite omitted/undefined, OR present but `expand` not passed, is
//       byte-identical to pre-FEAT-550 search() behavior. `expand: true` with a
//       resolved queryRewrite actually invokes the stage.
// AC-2: a hard timeout degrades to single-pass (original-query-only) behavior,
//       bounded total time.
// AC-3: hits are merged by atom id keeping the MAX score; the original query's
//       hits are always in the union even when a variant returns zero hits; the
//       merged candidate set is capped at maxCandidates.
// AC-5: a rewrite call that succeeds but returns zero usable variants degrades
//       silently to the original-query-only path (no error).

import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import { type QueryRewriteOpts, type QueryRewriter } from '../../src/search/query-rewrite.js';
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

/** Seeds a memory AND indexes it in the vector store. */
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

/** A hand-built QueryRewriter test double (mirrors decompose-integration.test.ts's
 *  `fixedDecomposer` pattern) — not MockQueryRewriter's heuristic, so the variant
 *  returned is exactly under the test's control. */
function fixedRewriter(variants: string[]): QueryRewriter {
  return { name: 'mock', rewrite: async () => variants };
}

function rewriteOpts(rewriter: QueryRewriter, overrides: Partial<QueryRewriteOpts> = {}): QueryRewriteOpts {
  return {
    rewriter,
    maxVariants: 3,
    timeoutMs: 300,
    maxCandidates: 100,
    ...overrides,
  };
}

describe('search() + FEAT-550 query rewrite/expansion', () => {
  it('queryRewrite omitted: byte-identical ranked id order and scores to an explicit queryRewrite:undefined call', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-1');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'qr-2');

    const withoutRewrite = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const withUndefinedRewrite = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite: undefined, expand: true,
    });
    expect(withUndefinedRewrite.map(h => h.id)).toEqual(withoutRewrite.map(h => h.id));
    withUndefinedRewrite.forEach((h, i) => expect(h.score).toBeCloseTo(withoutRewrite[i]!.score, 6));
  });

  it('AC-1: a resolved queryRewrite WITHOUT expand:true never invokes the stage (byte-identical)', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-3');
    const idB = seed(db, 'a distinct alias-only fact never found by the primary query', 'qr-4');

    const baseline = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    const queryRewrite = rewriteOpts(fixedRewriter(['a distinct alias-only fact']));
    // expand omitted (falsy) — the stage must not run even though queryRewrite is set.
    const withoutExpand = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite,
    });
    expect(withoutExpand.map(h => h.id)).toEqual(baseline.map(h => h.id));
    expect(withoutExpand.map(h => h.id)).not.toContain(idB);
  });

  it('AC-1: config.search.queryRewrite.mode disabled (default) → resolveQueryRewriteOpts(config) is undefined end to end', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-5');

    const { resolveQueryRewriteOpts } = await import('../../src/search/query-rewrite.js');
    const { buildLLMProvider } = await import('../../src/providers/index.js');
    const queryRewrite = resolveQueryRewriteOpts(defaultConfig(), buildLLMProvider);
    expect(queryRewrite).toBeUndefined();

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('AC-1: expand:true + resolved queryRewrite actually retrieves a variant-only hit', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-6');
    // Findable only via the rewritten variant's own tokens — no overlap with
    // the primary query's FTS/vec candidates.
    const idB = seed(db, 'the marine biologist works at the downtown aquarium', 'qr-7');

    const baseline = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(baseline.map(h => h.id)).not.toContain(idB);

    const queryRewrite = rewriteOpts(fixedRewriter(['marine biologist downtown aquarium']));
    const withRewrite = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    expect(withRewrite.map(h => h.id)).toContain(idB);
  });

  it('AC-2: a hard timeout degrades to original-query-only behavior, bounded total time', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-8');

    const slowRewriter: QueryRewriter = {
      name: 'mock',
      rewrite: () => new Promise(resolve => setTimeout(() => resolve(['too late']), 5_000)),
    };
    const queryRewrite = rewriteOpts(slowRewriter, { timeoutMs: 30 });

    const start = Date.now();
    const hits = await search('sqlite-vec hybrid search please', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('AC-2: a rewriter that throws degrades to original-query-only behavior (no error)', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-9');

    const failingRewriter: QueryRewriter = {
      name: 'mock',
      rewrite: async () => { throw new Error('boom'); },
    };
    const queryRewrite = rewriteOpts(failingRewriter);

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('AC-5: a rewriter that succeeds but returns only an echo of the original query falls back silently', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-10');

    const echoRewriter: QueryRewriter = {
      name: 'mock',
      rewrite: async () => ['sqlite-vec hybrid search'], // identical to the query itself
    };
    const queryRewrite = rewriteOpts(echoRewriter);

    const baseline = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const withRewrite = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    expect(withRewrite.map(h => h.id)).toEqual(baseline.map(h => h.id));
  });

  it('AC-3: merges by atom id keeping the MAX score — a hit found by both primary and a variant keeps the higher score', async () => {
    const db = setupDb();
    const idA = await seedWithVec(db, 'Sam gave Melanie a sunset painting', 'qr-11');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'qr-12');

    const baseline = await search('Sam gave Melanie a painting', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const baselineScore = baseline.find(h => h.id === idA)!.score;

    // The variant is a near-duplicate phrasing of the same fact — it will
    // also match idA, and (because it's a distinct query string) fuseHits
    // normalizes its own candidate set independently, which can push idA's
    // score up or down relative to the primary pass. Either way,
    // mergeVariantHits must keep whichever is higher.
    const queryRewrite = rewriteOpts(fixedRewriter(['Sam gave Melanie a sunset painting']));
    const withRewrite = await search('Sam gave Melanie a painting', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    const mergedHit = withRewrite.find(h => h.id === idA)!;
    expect(mergedHit).toBeDefined();
    expect(mergedHit.score).toBeGreaterThanOrEqual(baselineScore - 1e-9);
  });

  it('AC-3: the original query\'s hits are always in the union even when the variant returns zero hits', async () => {
    const db = setupDb();
    const idA = await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-13');

    // A variant whose tokens match nothing in the store — zero hits.
    const queryRewrite = rewriteOpts(fixedRewriter(['zzz nonexistent gibberish term qqq']));
    const withRewrite = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    expect(withRewrite.map(h => h.id)).toContain(idA);
  });

  it('AC-3: caps the merged candidate set at maxCandidates', async () => {
    const db = setupDb();
    // Primary query matches one strong hit.
    await seedWithVec(db, 'Sam gave Melanie a sunset painting', 'qr-cap-a');
    // The variant finds several distinct additional candidates.
    const variantIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      variantIds.push(await seedWithVec(db, `marine biologist job listing number ${i} aquarium career`, `qr-cap-b-${i}`));
    }

    const queryRewrite = rewriteOpts(fixedRewriter(['marine biologist aquarium career']), { maxCandidates: 2 });
    const hits = await search('Sam gave Melanie a painting', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true,
    });
    // Only 2 candidates can survive the merge cap, so the final hit list
    // (bounded by that cap upstream of the limit truncation) can't exceed it.
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it('debug:true is unaffected by FEAT-550 — the fusion breakdown reflects only the primary pass', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'qr-dbg-a');
    const idB = seed(db, 'marine biologist works at the downtown aquarium', 'qr-dbg-b');

    const queryRewrite = rewriteOpts(fixedRewriter(['marine biologist downtown aquarium']));
    const debugHits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, queryRewrite, expand: true, debug: true,
    });
    expect(debugHits.map(h => h.id)).not.toContain(idB);
  });
});
