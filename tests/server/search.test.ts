import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { buildApp } from '../../src/server/app.js';
import { makeFakeVec } from '../../src/search/search.js';
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
});
