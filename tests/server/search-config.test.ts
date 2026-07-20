import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
import { defaultConfig } from '../../src/config/config.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';

function buildMockEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'mock',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'mock', dim: 1024 as const })
  };
}

// P0.1 (2026-07-20 retrieval overhaul, Wave 0): searchRoute() used to derive
// fusion weights from a locally-shadowed `const cfg = defaultConfig()`
// instead of the REAL `config` parameter passed in by src/server/app.ts —
// every config.yaml fusion-weight override (alpha/beta/gamma/delta/...)
// silently no-op'd on both GET /search and POST /recall, because
// resolvePresetWeights() always derived its base from the hardcoded
// defaults. This test proves the passed-in `config.search` weights actually
// reach fuseScores() and can flip ranking order for the SAME two candidates
// and the SAME query — not just get parsed and discarded.
describe('P0.1: passed-in config.search fusion weights reach fusion (not a defaultConfig() no-op)', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  function seed(text: string, importance: number): string {
    return repo.insert({
      type: 'fact',
      text,
      normalized_text: text.toLowerCase(),
      repo: 'myrepo', project: null, branch: null, agent: null, session_id: null,
      hash: Buffer.from(text).toString('hex').slice(0, 32),
      source_hash: null,
      importance,
    });
  }

  it('boosting gamma (importance) while zeroing alpha (bm25) flips ranking order for identical candidates/query', async () => {
    // idHighRelevance: BM25-dominant match (term repeated many times), LOW importance.
    const idHighRelevance = seed(
      'zephyr zephyr zephyr zephyr zephyr zephyr zephyr zephyr zephyr zephyr configuration note',
      0,
    );
    // idHighImportance: weak single-mention BM25 match, HIGH importance.
    const idHighImportance = seed('zephyr configuration mentioned once note', 1);

    const embed = buildMockEmbed();

    // Default config: alpha=0.4 (bm25) dominates gamma=0.1 (importance) — the
    // strong-relevance / low-importance candidate wins.
    const defaultApp = await buildApp({ db, token: 'tok', embed });
    const defaultRes = await defaultApp.inject({
      method: 'POST', url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'zephyr', limit: 10, mode: 'keyword' },
    });
    expect(defaultRes.statusCode).toBe(200);
    const defaultIds = (defaultRes.json().hits as Array<{ id: string }>).map(h => h.id);
    expect(defaultIds[0]).toBe(idHighRelevance);

    // Runtime config: gamma pushed to the governance ceiling (1.0), alpha
    // (and beta/delta/epsilon) driven to ~0 — importance now dominates
    // unconditionally, regardless of the exact bm25 magnitudes involved.
    const boostedConfig = {
      ...defaultConfig(),
      search: { ...defaultConfig().search, alpha: 0.01, beta: 0, gamma: 1.0, delta: 0, epsilon: 0 },
    };
    const boostedApp = await buildApp({ db, token: 'tok', embed, config: boostedConfig });
    const boostedRes = await boostedApp.inject({
      method: 'POST', url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'zephyr', limit: 10, mode: 'keyword' },
    });
    expect(boostedRes.statusCode).toBe(200);
    const boostedIds = (boostedRes.json().hits as Array<{ id: string }>).map(h => h.id);
    expect(boostedIds[0]).toBe(idHighImportance);

    // The flip is the proof: pre-fix, both requests silently used
    // defaultConfig()'s gamma=0.1/alpha=0.4 for fusion no matter what the
    // caller configured, so ranking order never changed.
    expect(boostedIds[0]).not.toBe(defaultIds[0]);
  });

  it('GET /search: the same config threading applies (not just POST /recall)', async () => {
    const idHighRelevance = seed(
      'quokka quokka quokka quokka quokka quokka quokka quokka quokka quokka husbandry note',
      0,
    );
    const idHighImportance = seed('quokka husbandry mentioned once note', 1);
    const embed = buildMockEmbed();

    // GET /search has no `mode` param (POST /recall-only, FEAT-532 L2) — but
    // neither seeded id was ever upserted into the vec store (plain
    // repo.insert() never indexes vectors, only /remember or an explicit
    // SqliteVecStore.upsert do), so the vector leg returns zero candidates
    // for either id regardless of hybrid mode: this stays a clean BM25-vs-
    // importance comparison without needing to force keyword mode.
    const defaultApp = await buildApp({ db, token: 'tok', embed });
    const defaultRes = await defaultApp.inject({
      method: 'GET',
      url: '/search?q=quokka',
      headers: { authorization: 'Bearer tok' },
    });
    expect(defaultRes.statusCode).toBe(200);
    expect((defaultRes.json().hits as Array<{ id: string }>)[0]?.id).toBe(idHighRelevance);

    const boostedConfig = {
      ...defaultConfig(),
      search: { ...defaultConfig().search, alpha: 0.01, beta: 0, gamma: 1.0, delta: 0, epsilon: 0 },
    };
    const boostedApp = await buildApp({ db, token: 'tok', embed, config: boostedConfig });
    const boostedRes = await boostedApp.inject({
      method: 'GET',
      url: '/search?q=quokka',
      headers: { authorization: 'Bearer tok' },
    });
    expect(boostedRes.statusCode).toBe(200);
    expect((boostedRes.json().hits as Array<{ id: string }>)[0]?.id).toBe(idHighImportance);
  });
});
