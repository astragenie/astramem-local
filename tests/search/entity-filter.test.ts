// FEAT-402 slice 2 — AC-4 (entity= pre-fusion intersection) and AC-6 (zeta
// ranking safety) end-to-end through search().

import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';
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

function seed(db: DB, text: string, hash: string): string {
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

/**
 * Seed a memory AND its vector row — required whenever a test's query
 * doesn't lexically contain every token of a single memory's text (FTS
 * treats multi-token queries as implicit AND, see search.ts escapeFtsQuery
 * doc comment), so the only remaining path into the candidate set is the
 * vector leg.
 */
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

describe('search() entity filter (AC-4)', () => {
  it('returns all-and-only entity-linked members of the FTS+vec candidate set', async () => {
    const db = setupDb();
    const entities = new EntityRepo(db);
    // Three lexically-identical-topic memories — all three are FTS/vec
    // candidates for the query below. Only two are entity-linked.
    const linked1 = seed(db, 'adopt postgres as the canonical store', 'h-ef-1');
    const linked2 = seed(db, 'postgres canonical store follow-up note', 'h-ef-2');
    const unlinked = seed(db, 'postgres canonical store rejected alternative', 'h-ef-3');
    const pgId = entities.upsert('postgres', 'tech');
    entities.link(linked1, pgId);
    entities.link(linked2, pgId);

    const hits = await search('postgres canonical store', { entity: 'postgres' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const ids = hits.map(h => h.id).sort();
    expect(ids).toEqual([linked1, linked2].sort());
    expect(ids).not.toContain(unlinked);
  });

  it('resolves case/whitespace-insensitively through the AC-9 normalize seam', async () => {
    const db = setupDb();
    const entities = new EntityRepo(db);
    const memId = seed(db, 'typescript strict mode decision', 'h-ef-4');
    entities.link(memId, entities.upsert('TypeScript', 'tech'));

    const hits = await search('typescript strict mode', { entity: '  TYPESCRIPT  ' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits.map(h => h.id)).toEqual([memId]);
  });

  it('an unresolvable entity name yields zero results, not an unfiltered search', async () => {
    const db = setupDb();
    seed(db, 'postgres canonical store decision', 'h-ef-5');

    const hits = await search('postgres canonical store', { entity: 'nonexistent-entity' }, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits).toEqual([]);
  });

  it('omitting the entity filter is unaffected (back-compat)', async () => {
    const db = setupDb();
    const memId = seed(db, 'postgres canonical store decision', 'h-ef-6');

    const hits = await search('postgres canonical store', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits.map(h => h.id)).toContain(memId);
  });
});

// FEAT-453 §3.3/AC-6 — entity + as_of together narrow SELECTION (not just
// projection): a memory whose matched fact link's effective window has
// closed is excluded, even though the same memory is still "current" and
// would be returned by a plain as_of query with no entity filter (Example 1
// vs Example 2, design doc §3.4).
describe('search() entity + as_of composition (FEAT-453 AC-6)', () => {
  it('excludes a memory once as_of falls outside the fact link window, though entity-less as_of still includes it', async () => {
    const db = setupDb();
    const entities = new EntityRepo(db);
    const validFrom = Date.parse('2026-01-01T00:00:00Z');
    const memId = new MemoryRepo(db).insert({
      type: 'fact', text: 'alice approved the pr', normalized_text: 'alice approved the pr',
      repo: 'r1', project: null, branch: null, agent: null,
      session_id: null, hash: 'h-ef-as-of-1', source_hash: null,
      valid_from: validFrom,
    });
    const aliceId = entities.upsert('alice', 'actor');
    entities.linkWithValidity(memId, aliceId, {
      validAt: validFrom,
      invalidAt: Date.parse('2026-03-01T00:00:00Z'),
    });

    // Example 2: entity + as_of AFTER the fact link's window — excluded.
    const afterWindow = await search('alice approved the pr', {
      entity: 'alice',
      as_of: Date.parse('2026-04-01T00:00:00Z'),
    }, 10, { db, embed: fakeEmbed, weights: defaultConfig().search });
    expect(afterWindow.map(h => h.id)).not.toContain(memId);

    // Example 2: entity + as_of INSIDE the fact link's window — included.
    const insideWindow = await search('alice approved the pr', {
      entity: 'alice',
      as_of: Date.parse('2026-02-01T00:00:00Z'),
    }, 10, { db, embed: fakeEmbed, weights: defaultConfig().search });
    expect(insideWindow.map(h => h.id)).toContain(memId);

    // Example 1: plain as_of, no entity filter, same instant AFTER the fact
    // link's window — the memory is STILL returned (memory-level window is
    // unaffected by fact-level windows; projection only).
    const plainAsOf = await search('alice approved the pr', {
      as_of: Date.parse('2026-04-01T00:00:00Z'),
    }, 10, { db, embed: fakeEmbed, weights: defaultConfig().search });
    expect(plainAsOf.map(h => h.id)).toContain(memId);
  });
});

describe('search() zeta ranking safety (AC-6)', () => {
  // Freshness (the δ component) is computed from Date.now() at call time —
  // two back-to-back search() calls a few ms apart would otherwise produce
  // infinitesimally different scores that have nothing to do with zeta.
  // Freezing Date.now() isolates "did zeta change anything" from that
  // unrelated wall-clock jitter.
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('zeta=0 (default) produces identical order/scores before and after entity links are added', async () => {
    const db = setupDb();
    const m1 = await seedWithVec(db, 'sqlite-vec embedded vector search', 'h-z-1');
    const m2 = await seedWithVec(db, 'sqlite-vec embedded vector search library', 'h-z-2');

    const frozenNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

    const before = await search('sqlite-vec vector search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    // Same db, same ids — only difference is these memories are NOW
    // entity-linked. With zeta=0 (default) that MUST NOT move the needle.
    const entities = new EntityRepo(db);
    const id = entities.upsert('sqlite-vec', 'tech');
    entities.link(m1, id);
    entities.link(m2, id);

    const after = await search('sqlite-vec vector search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });

    expect(after.map(h => h.id)).toEqual(before.map(h => h.id));
    expect(after.map(h => h.score)).toEqual(before.map(h => h.score));
    expect(before.map(h => h.id).sort()).toEqual([m1, m2].sort());
  });

  it('zeta=0 explicit vs zeta omitted from weights are byte-identical (structural no-op)', async () => {
    const db = setupDb();
    seed(db, 'fastify server framework decision', 'h-z-3');
    seed(db, 'fastify vs express comparison note', 'h-z-4');

    const frozenNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

    const { zeta: _zeta, ...weightsWithoutZeta } = defaultConfig().search;
    const hitsExplicitZero = await search('fastify server framework', {}, 10, {
      db, embed: fakeEmbed, weights: { ...weightsWithoutZeta, zeta: 0 },
    });
    const hitsOmitted = await search('fastify server framework', {}, 10, {
      db, embed: fakeEmbed, weights: weightsWithoutZeta,
    });
    expect(hitsExplicitZero).toEqual(hitsOmitted);
  });

  it('zeta>0 boosts a candidate entity-linked to an entity mentioned in the query text', async () => {
    const db = setupDb();
    // Two memories seeded with DISTINCT text (both vector-indexed so they're
    // candidates regardless of FTS's implicit-AND behavior across tokens);
    // only "boosted" is entity-linked to "sqlite-vec", which the query text
    // also mentions.
    const plain = await seedWithVec(db, 'general database tooling notes for the platform team', 'h-z-5');
    const boosted = await seedWithVec(db, 'sqlite-vec', 'h-z-6');
    const entities = new EntityRepo(db);
    entities.link(boosted, entities.upsert('sqlite-vec', 'tech'));

    const withoutZeta = await search('sqlite-vec database tooling', {}, 10, {
      db, embed: fakeEmbed, weights: { ...defaultConfig().search, zeta: 0 },
    });
    const withZeta = await search('sqlite-vec database tooling', {}, 10, {
      db, embed: fakeEmbed, weights: { ...defaultConfig().search, zeta: 5 },
    });

    expect(withoutZeta.map(h => h.id).sort()).toEqual([plain, boosted].sort());

    const boostedScoreWithout = withoutZeta.find(h => h.id === boosted)?.score ?? 0;
    const boostedScoreWith = withZeta.find(h => h.id === boosted)?.score ?? 0;
    expect(boostedScoreWith).toBeGreaterThan(boostedScoreWithout);
    expect(withZeta.map(h => h.id)).toContain(plain);
  });
});
