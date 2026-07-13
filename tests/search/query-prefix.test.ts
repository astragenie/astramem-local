// RECALL-S1 — query-side embedding instruction prefix (mxbai-embed-large
// asymmetric retrieval fix). Three things must hold, each with its own test
// group below:
//   1. The prefix reaches the EMBEDDER only, prepended exactly once to the
//      string handed to embed.embed([...]) at the search.ts vector-embed
//      call site — never anywhere else.
//   2. The FTS5/BM25 query text is byte-identical whether or not a prefix
//      is configured — the asymmetry is query-embed-only, not query-text-wide.
//   3. resolveEmbedQueryPrefix (src/contracts/embed.ts) resolves the correct
//      per-model default, honors an explicit override (including forcing no
//      prefix), and defaults an unrecognized model to no prefix.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { QUERY_PREFIX_BY_MODEL, resolveEmbedQueryPrefix } from '../../src/contracts/embed.js';
import { defaultConfig } from '../../src/config/config.js';
import { getProviders } from '../../src/providers/index.js';
import { OllamaEmbedProvider } from '../../src/providers/embed/ollama.js';

const SEARCH_WEIGHTS = { alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };
const MXBAI_PREFIX = 'Represent this sentence for searching relevant passages: ';

function seed(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

/** Wraps db.prepare so every FTS5 MATCH statement's bound query param is
 *  captured in call order — the ground truth for "did the FTS arm see the
 *  raw query, unmodified" independent of anything search() does internally. */
function captureFtsMatchParams(db: DB): string[] {
  const captured: string[] = [];
  const originalPrepare = db.prepare.bind(db);
  vi.spyOn(db, 'prepare').mockImplementation(((sql: string) => {
    const stmt = originalPrepare(sql);
    if (sql.includes('memories_fts')) {
      const originalAll = stmt.all.bind(stmt);
      stmt.all = ((...args: unknown[]) => {
        captured.push(String(args[0]));
        return originalAll(...(args as []));
      }) as typeof stmt.all;
    }
    return stmt;
  }) as typeof db.prepare);
  return captured;
}

describe('RECALL-S1: query-side embedding prefix reaches the embedder only', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prepends embed.queryPrefix to the string passed to embed.embed([...]) exactly once', async () => {
    const db = setupDb();
    seed(db, 'astramem query prefix regression fixture', 'qp-1');

    const embedCalls: string[][] = [];
    const embed: EmbedProvider = {
      name: 'ollama',
      model: 'mxbai-embed-large',
      dim: 1024,
      queryPrefix: MXBAI_PREFIX,
      embed: async (texts: string[]) => {
        embedCalls.push(texts);
        return texts.map(t => makeFakeVec(t));
      },
      health: async () => ({ ok: true, model: 'mxbai-embed-large', dim: 1024 }),
    };

    await search('astramem query prefix regression fixture', {}, 10, {
      db, embed, weights: SEARCH_WEIGHTS,
    });

    expect(embedCalls).toHaveLength(1);
    expect(embedCalls[0]).toEqual([`${MXBAI_PREFIX}astramem query prefix regression fixture`]);
  });

  it('does not prepend anything when embed.queryPrefix is unset (undefined)', async () => {
    const db = setupDb();
    seed(db, 'no prefix configured fixture', 'qp-2');

    const embedCalls: string[][] = [];
    const embed: EmbedProvider = {
      name: 'ollama',
      model: 'some-other-model',
      dim: 1024,
      // queryPrefix intentionally omitted
      embed: async (texts: string[]) => {
        embedCalls.push(texts);
        return texts.map(t => makeFakeVec(t));
      },
      health: async () => ({ ok: true, model: 'some-other-model', dim: 1024 }),
    };

    await search('no prefix configured fixture', {}, 10, { db, embed, weights: SEARCH_WEIGHTS });

    expect(embedCalls).toEqual([['no prefix configured fixture']]);
  });

  it('does not prepend anything when embed.queryPrefix is the empty string', async () => {
    const db = setupDb();
    seed(db, 'empty string prefix fixture', 'qp-3');

    const embedCalls: string[][] = [];
    const embed: EmbedProvider = {
      name: 'ollama', model: 'mxbai-embed-large', dim: 1024, queryPrefix: '',
      embed: async (texts: string[]) => { embedCalls.push(texts); return texts.map(t => makeFakeVec(t)); },
      health: async () => ({ ok: true, model: 'mxbai-embed-large', dim: 1024 }),
    };

    await search('empty string prefix fixture', {}, 10, { db, embed, weights: SEARCH_WEIGHTS });

    expect(embedCalls).toEqual([['empty string prefix fixture']]);
  });
});

describe('RECALL-S1: FTS5/BM25 query text is byte-identical regardless of the embed prefix', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('the FTS MATCH bound param is exactly escapeFtsQuery(query) whether or not a prefix is configured', async () => {
    const rawQuery = 'astramem hybrid search fusion regression';

    const dbNoPrefix = setupDb();
    seed(dbNoPrefix, rawQuery, 'qp-fts-1');
    const capturedNoPrefix = captureFtsMatchParams(dbNoPrefix);
    const embedNoPrefix: EmbedProvider = {
      name: 'ollama', model: 'plain', dim: 1024,
      embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
      health: async () => ({ ok: true, model: 'plain', dim: 1024 }),
    };
    await search(rawQuery, {}, 10, { db: dbNoPrefix, embed: embedNoPrefix, weights: SEARCH_WEIGHTS });

    const dbWithPrefix = setupDb();
    seed(dbWithPrefix, rawQuery, 'qp-fts-2');
    const capturedWithPrefix = captureFtsMatchParams(dbWithPrefix);
    const embedWithPrefix: EmbedProvider = {
      name: 'ollama', model: 'mxbai-embed-large', dim: 1024, queryPrefix: MXBAI_PREFIX,
      embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
      health: async () => ({ ok: true, model: 'mxbai-embed-large', dim: 1024 }),
    };
    await search(rawQuery, {}, 10, { db: dbWithPrefix, embed: embedWithPrefix, weights: SEARCH_WEIGHTS });

    expect(capturedNoPrefix).toHaveLength(1);
    expect(capturedWithPrefix).toHaveLength(1);
    // The bound MATCH parameter must be identical — no trace of the
    // instruction-prefix vocabulary anywhere near the FTS arm.
    expect(capturedWithPrefix[0]).toEqual(capturedNoPrefix[0]);
    expect(capturedWithPrefix[0]).not.toContain('Represent this sentence');
  });

  it('byte-identical regression: keyword-only search() results (ids, scores, order) are unaffected by embed.queryPrefix', async () => {
    // Force FTS-only mode (vector arm unavailable) on both runs so the
    // comparison isolates the FTS/BM25 path from any vector-side effect —
    // this is the harness's own AC-4-style fallback (see search-debug.test.ts).
    const failingEmbedNoPrefix: EmbedProvider = {
      name: 'ollama', model: 'plain', dim: 1024,
      embed: async () => { throw new Error('embed provider down'); },
      health: async () => ({ ok: false, model: 'plain', dim: 1024 }),
    };
    const failingEmbedWithPrefix: EmbedProvider = {
      name: 'ollama', model: 'mxbai-embed-large', dim: 1024, queryPrefix: MXBAI_PREFIX,
      embed: async () => { throw new Error('embed provider down'); },
      health: async () => ({ ok: false, model: 'mxbai-embed-large', dim: 1024 }),
    };

    // Score includes a freshness term derived from `created_at` vs. wall-clock
    // `now` (fuse.ts) — both `created_at` AND `Date.now()` are pinned to
    // fixed instants for both runs so the comparison is exact-score, not
    // just rank/text. Without this, the two search() calls landing a few
    // real-world ms apart would make freshness (and thus score) differ by
    // float noise entirely unrelated to this regression.
    const FIXED_NOW = 1_800_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);

    const dbA = setupDb();
    const idA1 = seed(dbA, 'byte identical keyword only regression alpha', 'qp-bi-a1');
    const idA2 = seed(dbA, 'byte identical keyword only regression beta', 'qp-bi-a2');
    dbA.prepare('UPDATE memories SET created_at = ? WHERE id IN (?, ?)').run(FIXED_NOW, idA1, idA2);
    const hitsNoPrefix = await search('byte identical keyword only regression', {}, 10, {
      db: dbA, embed: failingEmbedNoPrefix, weights: SEARCH_WEIGHTS,
    });

    const dbB = setupDb();
    const idB1 = seed(dbB, 'byte identical keyword only regression alpha', 'qp-bi-b1');
    const idB2 = seed(dbB, 'byte identical keyword only regression beta', 'qp-bi-b2');
    dbB.prepare('UPDATE memories SET created_at = ? WHERE id IN (?, ?)').run(FIXED_NOW, idB1, idB2);
    const hitsWithPrefix = await search('byte identical keyword only regression', {}, 10, {
      db: dbB, embed: failingEmbedWithPrefix, weights: SEARCH_WEIGHTS,
    });

    expect(hitsWithPrefix.map(h => ({ type: h.type, text: h.text, score: h.score, source: h.source })))
      .toEqual(hitsNoPrefix.map(h => ({ type: h.type, text: h.text, score: h.score, source: h.source })));
  });
});

describe('RECALL-S1: resolveEmbedQueryPrefix', () => {
  it('resolves the built-in mxbai-embed-large default', () => {
    expect(resolveEmbedQueryPrefix('mxbai-embed-large')).toBe(MXBAI_PREFIX);
    expect(QUERY_PREFIX_BY_MODEL['mxbai-embed-large']).toBe(MXBAI_PREFIX);
  });

  it('defaults an unregistered model to no prefix — never inherits mxbai\'s string', () => {
    expect(resolveEmbedQueryPrefix('nomic-embed-text-v2-moe')).toBe('');
    expect(resolveEmbedQueryPrefix('text-embedding-3-small')).toBe('');
    expect(resolveEmbedQueryPrefix('totally-unknown-model')).toBe('');
  });

  it('an explicit override wins over the built-in map, including for mxbai-embed-large', () => {
    expect(resolveEmbedQueryPrefix('mxbai-embed-large', 'custom prefix: ')).toBe('custom prefix: ');
  });

  it('an explicit empty-string override forces no prefix even for a model with a built-in default', () => {
    expect(resolveEmbedQueryPrefix('mxbai-embed-large', '')).toBe('');
  });

  it('an explicit override applies to an otherwise-unregistered model too', () => {
    expect(resolveEmbedQueryPrefix('some-new-model', 'search query: ')).toBe('search query: ');
  });
});

describe('RECALL-S1: config wiring end-to-end via getProviders', () => {
  it('defaultConfig() (model=mxbai-embed-large, no override) resolves the built-in prefix on the constructed provider', () => {
    const cfg = defaultConfig();
    expect(cfg.embedding.model).toBe('mxbai-embed-large');
    expect(cfg.embedding.queryPrefix).toBeUndefined();

    const { embed } = getProviders(cfg);
    expect(embed).toBeInstanceOf(OllamaEmbedProvider);
    expect(embed.queryPrefix).toBe(MXBAI_PREFIX);
  });

  it('a different model with no override resolves to no prefix', () => {
    const cfg = defaultConfig();
    cfg.embedding.model = 'nomic-embed-text-v2-moe';
    const { embed } = getProviders(cfg);
    expect(embed.queryPrefix).toBe('');
  });

  it('an explicit config.embedding.queryPrefix override is honored end-to-end', () => {
    const cfg = defaultConfig();
    cfg.embedding.queryPrefix = 'my custom instruction: ';
    const { embed } = getProviders(cfg);
    expect(embed.queryPrefix).toBe('my custom instruction: ');
  });
});
