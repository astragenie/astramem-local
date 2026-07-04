// SLICE-410-3 — search() debug:true fusion-intermediates path.
// AC-1: per-candidate raw+normalized bm25/cosine, importance, freshness,
//       fused score/weights, not collapsed to SearchHit.
// AC-2: debug:false/omitted stays byte-identical to pre-change behavior.
// AC-3: component values assert exactly and score is reproducible from the
//       documented weights formula.
// AC-4: FTS hits but no vector hits (embed down) degrade to a documented
//       sentinel, not a throw.
// AC-5: empty query / zero candidates → debug returns [], not an error.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

// Embed provider that always fails — forces search() into its FTS-only
// fallback path (the `catch` around the vector-search leg in search.ts).
const failingEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async () => { throw new Error('embed provider down'); },
  health: async () => ({ ok: false, model: 'fake', dim: 1024 as const }),
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

describe('search() debug:true (SLICE-410-3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AC-1: both FTS and vector hits → per-candidate components, not collapsed to SearchHit', async () => {
    const db = setupDb();
    const id = await seedWithVec(db, 'sqlite-vec hybrid search fusion', 'h-d-1');

    const hits = await search('sqlite-vec hybrid search fusion', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, debug: true,
    });

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.id).toBe(id);
    expect(hit.source).toBe('both');
    expect(hit.bm25.raw).not.toBeNull();
    expect(hit.cosine.raw).not.toBeNull();
    expect(typeof hit.bm25.normalized).toBe('number');
    expect(typeof hit.cosine.normalized).toBe('number');
    expect(typeof hit.importance).toBe('number');
    expect(typeof hit.freshness).toBe('number');
    expect(typeof hit.score).toBe('number');
    // Weights are reported weightSum-normalized (effective values) so the
    // documented reconstruction formula matches fuseScores()' [0,1] wire
    // contract exactly (fix(search) cedc8a9 + FEAT-410 follow-up).
    const cfg = defaultConfig().search;
    const cfgZeta = (cfg as { zeta?: number }).zeta ?? 0;
    const wSum = cfg.alpha + cfg.beta + cfg.gamma + cfg.delta + (cfg.epsilon ?? 0) + cfgZeta;
    expect(hit.weights).toEqual({
      alpha: cfg.alpha / wSum,
      beta: cfg.beta / wSum,
      gamma: cfg.gamma / wSum,
      delta: cfg.delta / wSum,
      epsilon: (cfg.epsilon ?? 0) / wSum,
      zeta: cfgZeta / wSum,
    });
    // Not a SearchHit — no `type`/`text` collapse fields.
    expect(hit).not.toHaveProperty('type');
    expect(hit).not.toHaveProperty('text');
  });

  it('AC-2: debug:false and debug omitted are byte-identical SearchHit output', async () => {
    const db = setupDb();
    await seedWithVec(db, 'byte identical debug false omitted check', 'h-d-2');

    const frozenNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

    const withDebugFalse = await search('byte identical debug false omitted check', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, debug: false,
    });
    const withDebugOmitted = await search('byte identical debug false omitted check', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(withDebugFalse).toEqual(withDebugOmitted);
    // Still the pre-change SearchHit shape.
    expect(withDebugFalse[0]).toHaveProperty('type');
    expect(withDebugFalse[0]).toHaveProperty('text');
  });

  it('AC-3: component values are exact and score reproduces from documented weights', async () => {
    const db = setupDb();
    await seedWithVec(db, 'reproducible fused score from weights', 'h-d-3');

    const frozenNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

    const weights = defaultConfig().search;
    const [hit] = await search('reproducible fused score from weights', {}, 10, {
      db, embed: fakeEmbed, weights, debug: true,
    });

    expect(hit).toBeDefined();
    const h = hit!;
    const reconstructed =
      h.weights.alpha * h.bm25.normalized +
      h.weights.beta * h.cosine.normalized +
      h.weights.gamma * h.importance +
      h.weights.delta * h.freshness +
      h.weights.epsilon * h.usefulness +
      h.weights.zeta * h.entityBonus;

    expect(h.score).toBeCloseTo(reconstructed, 10);
    // Single candidate → normalizeScores' all-equal branch returns 1.
    expect(h.bm25.normalized).toBe(1);
    expect(h.cosine.normalized).toBe(1);
    // No usefulness signal recorded yet → Laplace-smoothed neutral default.
    expect(h.usefulness).toBe(0.5);
    // zeta defaults to 0 → entityBonus contributes nothing regardless of value.
    expect(h.weights.zeta).toBe(0);
  });

  it('AC-4: FTS hits but no vector hits (embed down) degrade to a documented sentinel, not a throw', async () => {
    const db = setupDb();
    const id = seed(db, 'fts only degraded embed sentinel check', 'h-d-4');

    const hits = await search('fts only degraded embed sentinel check', {}, 10, {
      db, embed: failingEmbed, weights: defaultConfig().search, debug: true,
    });

    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.id).toBe(id);
    expect(hit.source).toBe('fts');
    expect(hit.bm25.raw).not.toBeNull();
    // Documented sentinel: no vector leg at all → raw null, normalized 0.
    expect(hit.cosine.raw).toBeNull();
    expect(hit.cosine.normalized).toBe(0);
    // score must still reproduce from the sentinel values (no NaN/throw).
    const reconstructed =
      hit.weights.alpha * hit.bm25.normalized +
      hit.weights.beta * hit.cosine.normalized +
      hit.weights.gamma * hit.importance +
      hit.weights.delta * hit.freshness +
      hit.weights.epsilon * hit.usefulness +
      hit.weights.zeta * hit.entityBonus;
    expect(hit.score).toBeCloseTo(reconstructed, 10);
  });

  it('AC-5: empty query returns [] in debug mode, not an error', async () => {
    const db = setupDb();
    seed(db, 'some memory that would otherwise match', 'h-d-5');

    const hits = await search('', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, debug: true,
    });
    expect(hits).toEqual([]);
  });

  it('AC-5: zero candidates (no matching memories) returns [] in debug mode, not an error', async () => {
    const db = setupDb();

    const hits = await search('nothing matches anything here', {}, 10, {
      db, embed: failingEmbed, weights: defaultConfig().search, debug: true,
    });
    expect(hits).toEqual([]);
  });
});
