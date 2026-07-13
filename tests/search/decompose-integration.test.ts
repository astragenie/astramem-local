// WS6 — multi-hop query decomposition wired into search() (src/search/decompose.ts).
//
// AC: decompose omitted/undefined (the default, config.multiHop.enabled: false)
//     is byte-identical to pre-WS6 search() behavior.
// AC: a 2-hop question retrieves the second-hop atom that single-pass search() misses.
// AC: the dilution bound holds — a supplemental hit's damped score never
//     reaches what an equally-strong direct hit scores, and it never evicts
//     an existing primary hit from the returned set (pure addition).
// AC: maxSupplemental caps how many new ids one decomposition can add.
// AC: a hard timeout degrades to single-pass behavior rather than blocking.

import { describe, it, expect, vi } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import { type DecomposeOpts, type QueryDecomposer } from '../../src/search/decompose.js';
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

/** A hand-built QueryDecomposer test double (mirrors rerank-integration.test.ts's
 *  pattern of injecting a custom CrossEncoderProvider directly) — not
 *  MockQueryDecomposer's heuristic, so the sub-query returned is exactly
 *  under the test's control. */
function fixedDecomposer(subQueries: string[]): QueryDecomposer {
  return { name: 'mock', decompose: async () => subQueries };
}

function decomposeOpts(decomposer: QueryDecomposer, overrides: Partial<DecomposeOpts> = {}): DecomposeOpts {
  return {
    decomposer,
    minQueryWords: 4,
    maxSubQueries: 3,
    maxSupplemental: 5,
    supplementalWeight: 0.5,
    timeoutMs: 300,
    ...overrides,
  };
}

describe('search() + WS6 multi-hop query decomposition', () => {
  it('decompose omitted: byte-identical ranked id order and scores to an explicit decompose:undefined call', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'wd-1');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'wd-2');

    const withoutDecompose = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const withUndefinedDecompose = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, decompose: undefined,
    });
    expect(withUndefinedDecompose.map(h => h.id)).toEqual(withoutDecompose.map(h => h.id));
    withUndefinedDecompose.forEach((h, i) => expect(h.score).toBeCloseTo(withoutDecompose[i]!.score, 6));
  });

  it('config.multiHop disabled (default) → resolveDecomposeOpts(config) is undefined end to end', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'wd-3');

    const { resolveDecomposeOpts } = await import('../../src/search/decompose.js');
    const { buildLLMProvider } = await import('../../src/providers/index.js');
    const decompose = resolveDecomposeOpts(defaultConfig(), buildLLMProvider);
    expect(decompose).toBeUndefined();

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, decompose,
    });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('a 2-hop question retrieves the second-hop atom that single-pass search() misses', async () => {
    const db = setupDb();
    // First-hop fact + distractors, all vector-indexed so the primary pass
    // returns a non-empty, realistic candidate set regardless of the
    // compound query's exact FTS match.
    await seedWithVec(db, 'Sam gave Melanie a sunset painting', 'mh-a');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'mh-d1');
    await seedWithVec(db, 'the weather in Seattle is often rainy', 'mh-d2');
    // Second-hop fact: NOT vector-indexed (plain seed only) — invisible to
    // the vec leg no matter what query runs. Its tokens ("sam"/"works")
    // don't overlap enough with the compound query below for FTS's
    // implicit-AND MATCH to find it via the primary pass either.
    const idB = seed(db, 'Sam works as a marine biologist at the aquarium', 'mh-b');

    const compoundQuery = 'who actually gave melanie the painting'; // 6 words

    const baseline = await search(compoundQuery, {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(baseline.map(h => h.id)).not.toContain(idB);

    const decompose = decomposeOpts(fixedDecomposer(['Sam works']));
    const withDecompose = await search(compoundQuery, {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, decompose,
    });
    expect(withDecompose.map(h => h.id)).toContain(idB);
  });

  it('dilution bound: a supplemental hit never evicts an existing primary hit, and its score is damped below its own undamped value', async () => {
    const db = setupDb();
    await seedWithVec(db, 'Sam gave Melanie a sunset painting', 'db-a');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'db-d1');
    const idB = seed(db, 'Sam works as a marine biologist at the aquarium', 'db-b');

    const compoundQuery = 'who actually gave melanie the painting';

    const baseline = await search(compoundQuery, {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const baselineIds = new Set(baseline.map(h => h.id));

    const decompose = decomposeOpts(fixedDecomposer(['Sam works']), { supplementalWeight: 0.3 });
    const withDecompose = await search(compoundQuery, {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, decompose,
    });

    // Pure addition: every baseline id is still present.
    for (const id of baselineIds) {
      expect(withDecompose.map(h => h.id)).toContain(id);
    }

    const supplementalHit = withDecompose.find(h => h.id === idB)!;
    expect(supplementalHit).toBeDefined();
    const multiHopSignal = supplementalHit.explanation.signals.multi_hop!;
    expect(multiHopSignal).toBeDefined();
    // final (== top-level score) must be the RAW supplemental score damped
    // by supplementalWeight — never the undamped value.
    expect(supplementalHit.score).toBeCloseTo(multiHopSignal.raw * 0.3, 6);
    expect(supplementalHit.score).toBeLessThan(multiHopSignal.raw);
  });

  it('maxSupplemental caps how many new ids one decomposition can add', async () => {
    const db = setupDb();
    await seedWithVec(db, 'Sam gave Melanie a sunset painting', 'cap-a');
    // 4 distinct second-hop candidates, all findable only via the sub-query below.
    const capIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      capIds.push(seed(db, `Sam works job number ${i} marine biologist aquarium`, `cap-b-${i}`));
    }

    const compoundQuery = 'who actually gave melanie the painting';
    const decompose = decomposeOpts(fixedDecomposer(['Sam works']), { maxSupplemental: 2 });
    const hits = await search(compoundQuery, {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, decompose,
    });

    const addedCount = capIds.filter(id => hits.map(h => h.id).includes(id)).length;
    expect(addedCount).toBeLessThanOrEqual(2);
  });

  it('a hard timeout degrades to single-pass behavior rather than blocking the request', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'to-1');

    const slowDecomposer: QueryDecomposer = {
      name: 'mock',
      decompose: () => new Promise(resolve => setTimeout(() => resolve(['too late']), 5_000)),
    };
    const decompose = decomposeOpts(slowDecomposer, { timeoutMs: 30 });

    const start = Date.now();
    const hits = await search('sqlite-vec hybrid search please', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, decompose,
    });
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('debug:true is unaffected by WS6 — the fusion breakdown reflects only the primary pass', async () => {
    const db = setupDb();
    await seedWithVec(db, 'Sam gave Melanie a sunset painting', 'dbg-a');
    const idB = seed(db, 'Sam works as a marine biologist at the aquarium', 'dbg-b');

    const decompose = decomposeOpts(fixedDecomposer(['Sam works']));
    const debugHits = await search('who actually gave melanie the painting', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, decompose, debug: true,
    });
    expect(debugHits.map(h => h.id)).not.toContain(idB);
  });
});
