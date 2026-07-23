// Wave-6 — selective post-rerank evidence bundling wired into search()
// (src/search/evidence-bundle.ts).
//
// AC: evidenceBundling omitted/undefined (the default, config.evidenceBundling.
//     enabled: false) is byte-identical to pre-Wave-6 search() behavior.
// AC: config.evidenceBundling disabled (default) -> resolveEvidenceBundlingOpts(config)
//     is undefined end to end.
// AC: a thin-evidence result (finalized top-k spans fewer distinct sessions
//     than minDistinctSessions) triggers enrichment, pulling same-session and
//     same-entity atoms the base search excluded, each marked bundled/bundle_reason.
// AC: maxExtra caps how many extra atoms one enrichment pass can ever add.
// AC: a rich-evidence result (finalized top-k already spans enough distinct
//     sessions) never triggers enrichment — output is unchanged.
// AC: enrichment is pure addition — every base hit is still present, in its
//     original relative order, never reordered or dropped.

import { describe, it, expect } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import { resolveEvidenceBundlingOpts, type EvidenceBundlingOpts } from '../../src/search/evidence-bundle.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

/** `memories.session_id` is a FK into `sessions(id)` (migration 001) — a
 *  session row must exist before a memory can reference it. `INSERT OR
 *  IGNORE` makes this idempotent per-db, so callers can just call it on
 *  every seed() without tracking which sessionIds a given db already has. */
function ensureSession(db: DB, sessionId: string): void {
  db.prepare('INSERT OR IGNORE INTO sessions (id, repo, project, branch, agent, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, 'r1', null, null, null, Date.now());
}

function seed(db: DB, text: string, hash: string, sessionId: string | null = null): string {
  if (sessionId !== null) ensureSession(db, sessionId);
  return new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: sessionId, hash, source_hash: null,
  });
}

/** Seeds a memory AND indexes it in the vector store — required whenever a
 *  test wants an atom to actually surface in the finalized top-k via the vec
 *  leg (mirrors decompose-integration.test.ts's identical helper). */
async function seedWithVec(db: DB, text: string, hash: string, sessionId: string | null = null): Promise<string> {
  const id = seed(db, text, hash, sessionId);
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

function bundlingOpts(overrides: Partial<EvidenceBundlingOpts> = {}): EvidenceBundlingOpts {
  return { maxExtra: 5, minDistinctSessions: 2, sameEntity: true, sameSession: true, ...overrides };
}

describe('search() + Wave-6 evidence bundling', () => {
  it('evidenceBundling omitted: byte-identical ranked id order and scores to an explicit evidenceBundling:undefined call', async () => {
    const db = setupDb();
    await seedWithVec(db, 'melanie favorite lunch spot noodle shop downtown', 'eb-1');
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'eb-2');

    const withoutOpt = await search('melanie favorite lunch spot', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const withUndefinedOpt = await search('melanie favorite lunch spot', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, evidenceBundling: undefined,
    });
    expect(withUndefinedOpt.map(h => h.id)).toEqual(withoutOpt.map(h => h.id));
    withUndefinedOpt.forEach((h, i) => expect(h.score).toBeCloseTo(withoutOpt[i]!.score, 6));
    expect(withUndefinedOpt.some(h => h.bundled)).toBe(false);
  });

  it('config.evidenceBundling disabled (default) -> resolveEvidenceBundlingOpts(config) is undefined end to end', async () => {
    const db = setupDb();
    await seedWithVec(db, 'melanie favorite lunch spot noodle shop downtown', 'eb-3');

    const evidenceBundling = resolveEvidenceBundlingOpts(defaultConfig());
    expect(evidenceBundling).toBeUndefined();

    const hits = await search('melanie favorite lunch spot', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, evidenceBundling,
    });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some(h => h.bundled)).toBe(false);
  });

  it('thin evidence (finalized top-k all one session) pulls same-session AND same-entity atoms the base search excluded', async () => {
    const db = setupDb();
    const entities = new EntityRepo(db);

    // Both anchors: same session, strong lexical+vector overlap with the
    // query — guaranteed top-2 under limit:2.
    const anchorA = await seedWithVec(db, 'melanie favorite lunch spot is the noodle shop downtown', 'eb-a1', 's1');
    const anchorB = await seedWithVec(db, 'melanie favorite lunch spot changed to a new noodle shop', 'eb-a2', 's1');

    // Same-session distractor: zero query-term overlap, never a search()
    // candidate on its own merits — findable only via the session_id join.
    const sameSessionExtra = seed(db, 'completely unrelated banana bread recipe notes', 'eb-b1', 's1');

    // Same-entity distractor: different session, zero query-term overlap —
    // findable only via the memory_entities join to the entity linked on anchorA.
    const sameEntityExtra = seed(db, 'completely unrelated harbor workshop clock repairs', 'eb-b2', 's2');
    const melanieId = entities.upsert('melanie', 'human');
    entities.link(anchorA, melanieId);
    entities.link(sameEntityExtra, melanieId);

    const hits = await search('melanie favorite lunch spot', {}, 2, {
      db, embed: fakeEmbed, weights: defaultConfig().search, evidenceBundling: bundlingOpts(),
    });

    // Pure addition: both anchors still occupy the first two slots (whichever
    // order the base fusion pass ranked them — evidence-bundling doesn't
    // touch that), neither marked bundled.
    expect(hits.slice(0, 2).map(h => h.id).sort()).toEqual([anchorA, anchorB].sort());
    expect(hits[0]!.bundled).toBeUndefined();
    expect(hits[1]!.bundled).toBeUndefined();

    const bundled = hits.filter(h => h.bundled);
    const bundledIds = bundled.map(h => h.id);
    expect(bundledIds).toContain(sameSessionExtra);
    expect(bundledIds).toContain(sameEntityExtra);

    const sessionHit = bundled.find(h => h.id === sameSessionExtra)!;
    expect(sessionHit.bundle_reason).toBe('same_session');
    const entityHit = bundled.find(h => h.id === sameEntityExtra)!;
    expect(entityHit.bundle_reason).toBe('same_entity');

    // A bundled hit's synthetic score never outranks a real anchor hit.
    const minAnchorScore = Math.min(hits[0]!.score, hits[1]!.score);
    for (const h of bundled) expect(h.score).toBeLessThan(minAnchorScore);
  });

  it('rich evidence (finalized top-k already spans >= minDistinctSessions) never triggers enrichment', async () => {
    const db = setupDb();
    const anchorA = await seedWithVec(db, 'melanie favorite lunch spot is the noodle shop downtown', 'eb-c1', 's1');
    const anchorB = await seedWithVec(db, 'melanie favorite lunch spot changed to a new noodle shop', 'eb-c2', 's2');
    // Would be pulled in if enrichment fired — proves it genuinely didn't.
    seed(db, 'completely unrelated banana bread recipe notes', 'eb-c3', 's1');

    const hits = await search('melanie favorite lunch spot', {}, 2, {
      db, embed: fakeEmbed, weights: defaultConfig().search, evidenceBundling: bundlingOpts(),
    });

    expect(hits.map(h => h.id).sort()).toEqual([anchorA, anchorB].sort());
    expect(hits.some(h => h.bundled)).toBe(false);
  });

  it('maxExtra bounds how many extra atoms one enrichment pass can ever add', async () => {
    const db = setupDb();
    const anchorA = await seedWithVec(db, 'melanie favorite lunch spot is the noodle shop downtown', 'eb-d1', 's1');
    const anchorB = await seedWithVec(db, 'melanie favorite lunch spot changed to a new noodle shop', 'eb-d2', 's1');
    // 4 distinct same-session distractors, all findable only via the
    // session_id join — well over maxExtra below.
    const distractorIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      distractorIds.push(seed(db, `completely unrelated distractor entry number ${i}`, `eb-d3-${i}`, 's1'));
    }

    const hits = await search('melanie favorite lunch spot', {}, 2, {
      db, embed: fakeEmbed, weights: defaultConfig().search, evidenceBundling: bundlingOpts({ maxExtra: 2 }),
    });

    const bundled = hits.filter(h => h.bundled);
    expect(bundled.length).toBe(2);
    // Anchors are unaffected regardless of the cap.
    expect(hits.map(h => h.id)).toEqual(expect.arrayContaining([anchorA, anchorB]));
    const addedDistractors = distractorIds.filter(id => bundled.map(h => h.id).includes(id));
    expect(addedDistractors.length).toBe(2);
  });

  it('sameSession:false / sameEntity:false independently gate their own scoped pull', async () => {
    const db = setupDb();
    const entities = new EntityRepo(db);
    const anchorA = await seedWithVec(db, 'melanie favorite lunch spot is the noodle shop downtown', 'eb-e1', 's1');
    const anchorB = await seedWithVec(db, 'melanie favorite lunch spot changed to a new noodle shop', 'eb-e2', 's1');
    const sameSessionExtra = seed(db, 'completely unrelated banana bread recipe notes', 'eb-e3', 's1');
    const sameEntityExtra = seed(db, 'completely unrelated harbor workshop clock repairs', 'eb-e4', 's2');
    const melanieId = entities.upsert('melanie', 'human');
    entities.link(anchorA, melanieId);
    entities.link(sameEntityExtra, melanieId);

    const sessionOnly = await search('melanie favorite lunch spot', {}, 2, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
      evidenceBundling: bundlingOpts({ sameEntity: false, sameSession: true }),
    });
    expect(sessionOnly.map(h => h.id)).toContain(sameSessionExtra);
    expect(sessionOnly.map(h => h.id)).not.toContain(sameEntityExtra);

    const entityOnly = await search('melanie favorite lunch spot', {}, 2, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
      evidenceBundling: bundlingOpts({ sameEntity: true, sameSession: false }),
    });
    expect(entityOnly.map(h => h.id)).toContain(sameEntityExtra);
    expect(entityOnly.map(h => h.id)).not.toContain(sameSessionExtra);
  });

  it('debug:true is unaffected by Wave-6 — the fusion breakdown never runs the bundling stage', async () => {
    const db = setupDb();
    const anchorA = await seedWithVec(db, 'melanie favorite lunch spot is the noodle shop downtown', 'eb-f1', 's1');
    const anchorB = await seedWithVec(db, 'melanie favorite lunch spot changed to a new noodle shop', 'eb-f2', 's1');
    seed(db, 'completely unrelated banana bread recipe notes', 'eb-f3', 's1');

    const debugHits = await search('melanie favorite lunch spot', {}, 2, {
      db, embed: fakeEmbed, weights: defaultConfig().search, evidenceBundling: bundlingOpts(), debug: true,
    });
    expect(debugHits.map(h => h.id).sort()).toEqual([anchorA, anchorB].sort());
  });
});
