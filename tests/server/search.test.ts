import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
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

function seedMemory(repo: MemoryRepo, text: string, type = 'decision', repoName = 'myrepo') {
  return repo.insert({
    type: type as 'decision' | 'fact' | 'lesson' | 'command' | 'todo',
    text,
    normalized_text: text.toLowerCase(),
    repo: repoName,
    project: null,
    branch: null,
    agent: null,
    session_id: null,
    hash: Buffer.from(text).toString('hex').slice(0, 32),
    source_hash: null,
    importance: 0.8
  });
}

describe('GET /search', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    seedMemory(repo, 'use sqlite for local storage decision');
    seedMemory(repo, 'use postgres for production sync', 'fact');
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  it('returns hits for matching query', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=sqlite',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits).toBeDefined();
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits.length).toBeGreaterThan(0);
    const hit = body.hits[0];
    expect(hit).toHaveProperty('id');
    expect(hit).toHaveProperty('type');
    expect(hit).toHaveProperty('text');
    expect(hit).toHaveProperty('score');
    expect(hit).toHaveProperty('source');
    expect(['fts', 'vec', 'both']).toContain(hit.source);
  });

  it('filters by type param', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=postgres&type=decision',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // postgres memory is type=fact, so type=decision filter should exclude it
    for (const hit of body.hits) {
      expect(hit.type).toBe('decision');
    }
  });

  it('filters by repo param', async () => {
    // Insert memory in a different repo
    seedMemory(repo, 'other repo memory', 'fact', 'otherrepo');
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=memory&repo=otherrepo',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    for (const hit of body.hits) {
      // Fetching full record to verify repo
      const memRes = await app.inject({
        method: 'GET',
        url: `/memory/${hit.id}`,
        headers: { authorization: 'Bearer tok' }
      });
      expect(memRes.json().repo).toBe('otherrepo');
    }
  });

  it('respects limit param', async () => {
    // Add more memories
    for (let i = 0; i < 10; i++) {
      seedMemory(repo, `sqlite related memory number ${i}`);
    }
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=sqlite&limit=3',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits.length).toBeLessThanOrEqual(3);
  });

  it('returns 401 without bearer', async () => {
    const res = await app.inject({ method: 'GET', url: '/search?q=test' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 with missing q', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(400);
  });

  // ADR-010 (2e): every served hit gets a recall_served usefulness event.
  it('records a recall_served usefulness event per returned hit', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=sqlite',
      headers: { authorization: 'Bearer tok' }
    });
    const hits = res.json().hits as Array<{ id: string }>;
    expect(hits.length).toBeGreaterThan(0);

    const events = new MemoryEventRepo(db);
    for (const hit of hits) {
      const served = events.listForAtom(hit.id).filter(e => e.event_type === 'usefulness');
      expect(served.length).toBeGreaterThanOrEqual(1);
      const payload = JSON.parse(served[0]?.payload_json ?? '{}');
      expect(payload).toMatchObject({ family: 'recall_served', surface: 'rest', mode: 'search' });
      expect(typeof payload.query_hash).toBe('string');
      // Privacy: raw query text must never be persisted in the event payload.
      expect(JSON.stringify(payload)).not.toContain('sqlite');
    }
  });
});

describe('FEAT-401: as_of temporal filter — GET /search and POST /recall', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const t0 = 1_800_000_000_000;
  const t1 = t0 + 1000;
  const t2 = t0 + 2000;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  function seedSupersededPair(): { oldId: string; newId: string } {
    // Distinct first-16-char prefixes: seedMemory's dedup hash is derived
    // from the leading bytes of the text, and a shared prefix would collide
    // two logically-different rows into one insert (repo.insert dedups by
    // hash) — same trap FTS5 escaping already documents elsewhere.
    const oldId = seedMemory(repo, 'gen1(old): adopt postgres canonical store decision');
    const newId = seedMemory(repo, 'gen2(new): adopt postgres canonical store decision refined');
    db.prepare('UPDATE memories SET valid_from = ?, valid_to = ?, superseded_by = ? WHERE id = ?')
      .run(t0, t2, newId, oldId);
    db.prepare('UPDATE memories SET valid_from = ?, valid_to = NULL WHERE id = ?').run(t2, newId);
    return { oldId, newId };
  }

  it('AC-1 via GET /search: as_of before the supersede instant returns the old memory, not the successor', async () => {
    const { oldId, newId } = seedSupersededPair();
    const res = await app.inject({
      method: 'GET',
      url: `/search?q=postgres+canonical+store&as_of=${new Date(t1).toISOString()}`,
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().hits as Array<{ id: string }>).map(h => h.id);
    expect(ids).toContain(oldId);
    expect(ids).not.toContain(newId);
  });

  it('AC-4: POST /recall filters.as_of resolves to the identical hit set as GET /search as_of for the same instant', async () => {
    const { oldId, newId } = seedSupersededPair();
    const asOfIso = new Date(t1).toISOString();

    const getRes = await app.inject({
      method: 'GET',
      url: `/search?q=postgres+canonical+store&as_of=${asOfIso}`,
      headers: { authorization: 'Bearer tok' }
    });
    const postRes = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'postgres canonical store', k: 10, filters: { as_of: asOfIso } }
    });

    expect(getRes.statusCode).toBe(200);
    expect(postRes.statusCode).toBe(200);
    const getIds = (getRes.json().hits as Array<{ id: string }>).map(h => h.id).sort();
    const postIds = (postRes.json().hits as Array<{ id: string }>).map(h => h.id).sort();
    expect(postIds).toEqual(getIds);
    expect(getIds).toContain(oldId);
    expect(getIds).not.toContain(newId);
  });

  it('AC-2: omitting as_of on GET /search returns current-snapshot behavior unchanged', async () => {
    const { oldId, newId } = seedSupersededPair();
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=postgres+canonical+store',
      headers: { authorization: 'Bearer tok' }
    });
    const ids = (res.json().hits as Array<{ id: string }>).map(h => h.id);
    expect(ids).toContain(newId);
    expect(ids).not.toContain(oldId);
  });

  it('rejects an unparseable as_of on GET /search with 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=postgres&as_of=not-a-date',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unparseable as_of on POST /recall with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'postgres', k: 5, filters: { as_of: 'not-a-date' } }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /recall', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    seedMemory(repo, 'use sqlite-vec for vector storage');
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  it('returns hits in {hits: [...]} shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'vector storage', k: 5 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hits).toBeDefined();
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('accepts optional filters', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'vector', k: 5, filters: { type: ['decision'], repo: 'myrepo' } }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.hits)).toBe(true);
  });

  it('returns 400 if query is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { k: 5 }
    });
    expect(res.statusCode).toBe(400);
  });
});

// #112 (U3-local) AC-2: `text`/`limit` (ADR-005 canonical) and `query`/`k`
// (legacy) are both accepted for exactly one release on POST /recall.
describe('POST /recall — field-name aliases (#112 AC-2)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    seedMemory(repo, 'use sqlite-vec for vector storage');
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  it('accepts the canonical text/limit spelling', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'vector storage', limit: 5 }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.hits)).toBe(true);
    expect(body.hits.length).toBeGreaterThan(0);
  });

  it('legacy {query,k} and canonical {text,limit} return the same shape of response for the same request', async () => {
    const legacyRes = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'vector storage', k: 5 }
    });
    const canonicalRes = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'vector storage', limit: 5 }
    });
    expect(legacyRes.statusCode).toBe(200);
    expect(canonicalRes.statusCode).toBe(200);
    const legacyIds = (legacyRes.json().hits as Array<{ id: string }>).map(h => h.id).sort();
    const canonicalIds = (canonicalRes.json().hits as Array<{ id: string }>).map(h => h.id).sort();
    expect(canonicalIds).toEqual(legacyIds);
    expect(legacyIds.length).toBeGreaterThan(0);
  });

  it('returns 400 when neither text nor query is supplied', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { limit: 5 }
    });
    expect(res.statusCode).toBe(400);
  });

  it('limit defaults to 5 (preserving the pre-#112 k.default(5) behavior) when omitted', async () => {
    for (let i = 0; i < 10; i++) {
      seedMemory(repo, `vector storage related memory number ${i}`);
    }
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'vector storage' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits.length).toBeLessThanOrEqual(5);
  });
});

// #112 (U3-local) AC-1/AC-3: `filters.type` is now enum-validated against the
// shared MEMORY_TYPES union instead of accepting free-form strings.
describe('filters.type enum validation (#112 AC-1/AC-3)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    seedMemory(repo, 'use sqlite-vec for vector storage');
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  it('POST /recall rejects an out-of-union filters.type value with 400 naming the field', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'vector storage', limit: 5, filters: { type: ['bogus-value'] } }
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    // zod's flatten() only nests one level deep, so a bad `filters.type` value
    // surfaces under the `filters` key (not a further-nested `type` key) —
    // assert against that real shape, not a fabricated `type` field.
    expect(body.details.fieldErrors.filters).toBeDefined();
    expect(body.details.fieldErrors.filters[0]).toMatch(/invalid (option|enum value)|expected one of/i);
    expect(body.details.fieldErrors.filters[0]).toContain('decision'); // zod lists the valid options (zod4 drops the received value; both echo the union)
  });

  it('GET /search rejects an out-of-union type value with 400 naming the field', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/search?q=vector&type=bogus-value',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    // GET /search validates the parsed CSV list directly (`z.array(...).safeParse`),
    // so flatten() reports the offending index ("0") as the field key, not `type`.
    expect(body.details.fieldErrors['0']).toBeDefined();
    expect(body.details.fieldErrors['0'][0]).toMatch(/invalid (option|enum value)|expected one of/i);
    expect(body.details.fieldErrors['0'][0]).toContain('decision'); // zod lists the valid options (zod4 drops the received value; both echo the union)
  });

  it('POST /remember still rejects an invalid type the same way (no regression from the shared enum)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'hello', type: 'not-a-real-type' }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /remember', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  it('inserts memory and returns {id, ok: true}', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'use vitest for testing', type: 'decision' }
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('string');
  });

  // astramem-local#84: content_hash must be a full 64-char sha256 hex digest
  // (contracts/schemas/sync-envelope.v1.schema.json pattern ^[a-f0-9]{64}$),
  // not the legacy 32-char truncation. Asserted against the real DB row so
  // this exercises the actual POST /remember hash site, not a synthetic value.
  it('stores a full 64-char sha256 hex content hash, not a 32-char truncation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'astramem-local#84: hash must be 64 chars, not 32', type: 'fact' }
    });
    expect(res.statusCode).toBe(200);
    const { id } = res.json();
    const row = db.prepare('SELECT hash FROM memories WHERE id = ?').get(id) as { hash: string };
    expect(row.hash).toMatch(/^[a-f0-9]{64}$/);
    const event = db.prepare(`SELECT content_hash FROM memory_events WHERE atom_id = ? AND event_type = 'create'`).get(id) as { content_hash: string };
    expect(event.content_hash).toBe(row.hash);
  });

  it('inserted memory is findable via FTS', async () => {
    await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'prefer fastify over express for the daemon', type: 'decision' }
    });
    const searchRes = await app.inject({
      method: 'GET',
      url: '/search?q=fastify',
      headers: { authorization: 'Bearer tok' }
    });
    expect(searchRes.statusCode).toBe(200);
    const hits = searchRes.json().hits;
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].text).toContain('fastify');
  });

  it('inserted memory has vec row — search returns it via vector path', async () => {
    const remRes = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'sqlite-vec is embedded in better-sqlite3', type: 'fact' }
    });
    const { id } = remRes.json();
    // Verify vec row exists by checking memories_vec rowid corresponds to memories rowid
    const row = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(id) as { rowid: number };
    const vecRow = db.prepare('SELECT rowid FROM memories_vec WHERE rowid = ?').get(BigInt(row.rowid)) as { rowid: bigint } | undefined;
    expect(vecRow).toBeDefined();
  });

  it('accepts optional metadata', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: {
        text: 'always use strict TypeScript',
        type: 'lesson',
        metadata: { repo: 'my-project', importance: 0.9 }
      }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('returns 400 if text is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { type: 'fact' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 if type is invalid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'hello', type: 'unknown' }
    });
    expect(res.statusCode).toBe(400);
  });

  // Silent-error audit (2026-07-13): a failed embed/vec-upsert used to be
  // swallowed into a log line while the response still said {id, ok: true}
  // unconditionally — the caller had no way to know the memory was saved
  // FTS-only and not vector-indexed. vec_indexed: false now surfaces it.
  it('embed/vec upsert failure: memory still saved, but response reports vec_indexed: false instead of lying', async () => {
    const brokenEmbedApp = await buildApp({
      db,
      token: 'tok',
      embed: {
        ...buildMockEmbed(),
        embed: async () => { throw new Error('embed provider unreachable (test)'); },
      },
    });

    const res = await brokenEmbedApp.inject({
      method: 'POST',
      url: '/remember',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { text: 'this memory should still be saved despite a broken embed provider', type: 'fact' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.vec_indexed).toBe(false);

    // The memory itself IS durably saved (FTS-searchable) ...
    const row = db.prepare('SELECT id FROM memories WHERE id = ?').get(body.id);
    expect(row).toBeDefined();
    // ... but it never made it into the vector index.
    const rowid = db.prepare('SELECT rowid FROM memories WHERE id = ?').get(body.id) as { rowid: number };
    const vecRow = db.prepare('SELECT rowid FROM memories_vec WHERE rowid = ?').get(BigInt(rowid.rowid));
    expect(vecRow).toBeUndefined();
  });

  // FEAT-441 AC-5/AC-6: /remember writes a memory directly via
  // MemoryRepo.insertWithCreateEvent (search.ts:220) — it never routes
  // through the distill pipeline's embedAndIndex stage 8, so the durability
  // gate (src/distill/durability-gate.ts) never runs against it, even with
  // distill.durabilityGate: 'strict' configured. A deliberate /remember
  // outranks the heuristic gate. One body per AC-1 taxonomy class (matching
  // every gatedReason pattern the classifier recognizes) all persist with a
  // real row and the unchanged {id, ok: true} response shape.
  it('bypasses the durability gate entirely — every AC-1 low-durability pattern still persists, even with distill.durabilityGate: strict configured', async () => {
    const gatedApp = await buildApp({
      db,
      token: 'tok',
      embed: buildMockEmbed(),
      config: { ...defaultConfig(), distill: { durabilityGate: 'strict', extractProfile: 'engineering' } },
    });

    const lowDurabilityBodies: Array<{ text: string; type: string }> = [
      { text: 'Trunk status is green.', type: 'fact' },              // ephemeral_state
      { text: 'Commit a589551 fixed the prod tag deploy blocker.', type: 'fact' }, // git_derivable
      { text: 'No token handling identified in the auth module.', type: 'fact' }, // vacuous_negative
      { text: 'Run memory test', type: 'command' },                  // bare_todo
      { text: 'src/distill/stages/08-embed-index.ts:84', type: 'note' }, // path_fragment
    ];

    for (const body of lowDurabilityBodies) {
      const res = await gatedApp.inject({
        method: 'POST',
        url: '/remember',
        headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
        payload: body,
      });
      expect(res.statusCode, `POST /remember for "${body.text}"`).toBe(200);
      const parsed = res.json();
      expect(parsed).toEqual({ id: expect.any(String), ok: true });

      const row = db.prepare('SELECT id, text FROM memories WHERE id = ?').get(parsed.id) as
        | { id: string; text: string }
        | undefined;
      expect(row, `real row for "${body.text}"`).toBeTruthy();
      expect(row!.text).toBe(body.text);
    }
  });
});

// FEAT-402 slice 2 AC-4: entity= filter on GET /search and POST /recall.
describe('entity filter — GET /search and POST /recall (AC-4)', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  async function linkEntity(memId: string, name: string): Promise<string> {
    const { EntityRepo } = await import('../../src/storage/entities.js');
    const entities = new EntityRepo(db);
    const id = entities.upsert(name, 'tech');
    entities.link(memId, id);
    return id;
  }

  it('GET /search?entity= returns all-and-only entity-linked members', async () => {
    const linked = seedMemory(repo, 'adopt postgres as the canonical store decision', 'decision');
    const unlinked = seedMemory(repo, 'postgres canonical store rejected alternative decision', 'decision');
    await linkEntity(linked, 'postgres');

    const res = await app.inject({
      method: 'GET',
      url: '/search?q=postgres+canonical+store&entity=postgres',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(200);
    const ids = (res.json().hits as Array<{ id: string }>).map(h => h.id);
    expect(ids).toContain(linked);
    expect(ids).not.toContain(unlinked);
  });

  it('POST /recall filters.entity resolves to the identical hit set as GET /search entity= for the same query', async () => {
    const linked = seedMemory(repo, 'adopt postgres as the canonical store decision', 'decision');
    seedMemory(repo, 'postgres canonical store rejected alternative decision', 'decision');
    await linkEntity(linked, 'postgres');

    const getRes = await app.inject({
      method: 'GET',
      url: '/search?q=postgres+canonical+store&entity=postgres',
      headers: { authorization: 'Bearer tok' }
    });
    const postRes = await app.inject({
      method: 'POST',
      url: '/recall',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      payload: { query: 'postgres canonical store', k: 10, filters: { entity: 'postgres' } }
    });
    const getIds = (getRes.json().hits as Array<{ id: string }>).map(h => h.id).sort();
    const postIds = (postRes.json().hits as Array<{ id: string }>).map(h => h.id).sort();
    expect(postIds).toEqual(getIds);
    expect(getIds).toEqual([linked]);
  });

  it('an unresolvable entity name returns zero hits, not an unfiltered search', async () => {
    seedMemory(repo, 'postgres canonical store decision', 'decision');

    const res = await app.inject({
      method: 'GET',
      url: '/search?q=postgres+canonical+store&entity=nonexistent-entity',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hits).toEqual([]);
  });
});
