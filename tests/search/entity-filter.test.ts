// FEAT-402 slice 2 — AC-4 (entity= pre-fusion intersection) and AC-6 (zeta
// ranking safety) end-to-end through search().

import { describe, it, expect, vi, afterEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { search, makeFakeVec, entityNameMatchesQuery } from '../../src/search/search.js';
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

// Issue #207 AC-3/AC-6: entityBonusForQuery used to match via naked
// `query.includes(entityName)` — an entity named "go" would spuriously match
// any query containing "going". Direct unit tests on the exported matching
// helper, isolated from fuse.ts's weighted-normalization pipeline (where
// turning zeta on at all changes every candidate's score via a shared
// denominator, independent of whether a real bonus applied).
describe('entityNameMatchesQuery (issue #207 AC-3)', () => {
  it('does NOT match a substring inside a larger word ("go" inside "going")', () => {
    expect(entityNameMatchesQuery('going forward with the plan', 'go')).toBe(false);
  });

  it('matches when the name appears as its own word', () => {
    expect(entityNameMatchesQuery('go database tooling', 'go')).toBe(true);
    expect(entityNameMatchesQuery('database tooling for go', 'go')).toBe(true);
    expect(entityNameMatchesQuery('using go for the backend', 'go')).toBe(true);
  });

  it('matches a multi-word entity name as a whole phrase', () => {
    expect(entityNameMatchesQuery('claude code helped with this', 'claude code')).toBe(true);
    expect(entityNameMatchesQuery('claude codebase helped with this', 'claude code')).toBe(false);
  });

  it('matches a hyphenated entity name bounded correctly ("sqlite-vec")', () => {
    expect(entityNameMatchesQuery('sqlite-vec database tooling', 'sqlite-vec')).toBe(true);
    expect(entityNameMatchesQuery('sqlite-vector database tooling', 'sqlite-vec')).toBe(false);
  });

  it('handles regex-metacharacter entity names literally, not as regex syntax ("c#", "node.js")', () => {
    expect(entityNameMatchesQuery('written in c# for the backend', 'c#')).toBe(true);
    expect(entityNameMatchesQuery('written in c for the backend', 'c#')).toBe(false);
    expect(entityNameMatchesQuery('built with node.js', 'node.js')).toBe(true);
    expect(entityNameMatchesQuery('built with nodexjs', 'node.js')).toBe(false);
  });

  it('an empty name never matches', () => {
    expect(entityNameMatchesQuery('anything at all', '')).toBe(false);
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

  // Issue #207 AC-3: entityBonusForQuery used to match via naked
  // `query.includes(entityName)` — an entity named "go" would spuriously
  // match any query containing "going", "algorithm" would match "go", etc.
  // This is independent of the garbage-entity-name bug (#207's other half):
  // even a perfectly clean entity named "go" would incorrectly boost every
  // query containing "going" under the old substring logic.
  it('an entity named "go" does NOT boost a query containing "going" (word-boundary, not substring)', async () => {
    const db = setupDb();
    const goLinked = await seedWithVec(db, 'unrelated content linked to the go entity', 'h-z-7');
    const entities = new EntityRepo(db);
    entities.link(goLinked, entities.upsert('go', 'tech'));

    const frozenNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

    const withoutZeta = await search('going forward with the plan', {}, 10, {
      db, embed: fakeEmbed, weights: { ...defaultConfig().search, zeta: 0 },
    });
    const withZeta = await search('going forward with the plan', {}, 10, {
      db, embed: fakeEmbed, weights: { ...defaultConfig().search, zeta: 5 },
    });

    // "go" must not match inside "going" — with NO real bonus applied, the
    // score can only ever go DOWN (not up) between zeta=0 and zeta=5, since
    // turning zeta on alone dilutes every other weighted component via the
    // fuse.ts normalization denominator (see the zeta>0 no-op-on-unmatched
    // case). A genuine bonus, in contrast, overrides that dilution and
    // produces a net INCREASE — exactly what the previous test above
    // ('DOES boost') demonstrates for an actual whole-word match at the same
    // zeta=5 weight. Under the old naked-substring bug, "go" would have
    // incorrectly matched inside "going" and produced that same increase
    // here too — this assertion is what would have caught it.
    const goLinkedScoreWithout = withoutZeta.find(h => h.id === goLinked)?.score ?? 0;
    const goLinkedScoreWith = withZeta.find(h => h.id === goLinked)?.score ?? 0;
    expect(goLinkedScoreWith).toBeLessThanOrEqual(goLinkedScoreWithout);
  });

  it('an entity named "go" DOES boost a query where "go" appears as its own word', async () => {
    const db = setupDb();
    const plain = await seedWithVec(db, 'general database tooling notes for the platform team', 'h-z-9');
    const boosted = await seedWithVec(db, 'go', 'h-z-10');
    const entities = new EntityRepo(db);
    entities.link(boosted, entities.upsert('go', 'tech'));

    const withoutZeta = await search('go database tooling', {}, 10, {
      db, embed: fakeEmbed, weights: { ...defaultConfig().search, zeta: 0 },
    });
    const withZeta = await search('go database tooling', {}, 10, {
      db, embed: fakeEmbed, weights: { ...defaultConfig().search, zeta: 5 },
    });

    const boostedScoreWithout = withoutZeta.find(h => h.id === boosted)?.score ?? 0;
    const boostedScoreWith = withZeta.find(h => h.id === boosted)?.score ?? 0;
    expect(boostedScoreWith).toBeGreaterThan(boostedScoreWithout);
    expect(withZeta.map(h => h.id)).toContain(plain);
  });
});
