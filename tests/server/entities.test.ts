// FEAT-402 slice 2 AC-5: GET /entities?q= and GET /entities/:id/memories.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { EntityRepo } from '../../src/storage/entities.js';
import { MemoryEventRepo } from '../../src/storage/memory-events.js';
import { buildApp } from '../../src/server/app.js';
import type { DB } from '../../src/storage/db.js';

function seedMemory(repo: MemoryRepo, text: string, hash: string) {
  return repo.insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
  });
}

describe('GET /entities', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let entities: EntityRepo;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    entities = new EntityRepo(db);
    entities.upsert('PostgreSQL', 'tech');
    entities.upsert('TypeScript', 'tech');
    app = await buildApp({ db, token: 'tok' });
  });

  it('returns matching entities for a substring query', async () => {
    const res = await app.inject({
      method: 'GET', url: '/entities?q=post',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entities: Array<{ name: string }> };
    expect(body.entities.map(e => e.name)).toEqual(['postgresql']);
  });

  it('returns all entities alphabetically when q is omitted', async () => {
    const res = await app.inject({
      method: 'GET', url: '/entities',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entities: Array<{ name: string }> };
    expect(body.entities.map(e => e.name)).toEqual(['postgresql', 'typescript']);
  });

  it('returns 401 without a Bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/entities?q=post' });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /entities/:id/memories', () => {
  let db: DB;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    app = await buildApp({ db, token: 'tok' });
  });

  it('returns every memory linked to the entity', async () => {
    const memRepo = new MemoryRepo(db);
    const entities = new EntityRepo(db);
    const m1 = seedMemory(memRepo, 'adopt postgres as the canonical store', 'h-er-1');
    const m2 = seedMemory(memRepo, 'postgres migration checklist', 'h-er-2');
    seedMemory(memRepo, 'unrelated typescript note', 'h-er-3');
    const pgId = entities.upsert('postgres', 'tech');
    entities.link(m1, pgId);
    entities.link(m2, pgId);

    const res = await app.inject({
      method: 'GET', url: `/entities/${pgId}/memories`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { entity: { id: string; name: string }; memories: Array<{ id: string }> };
    expect(body.entity).toEqual({ id: pgId, name: 'postgres', kind: 'tech' });
    expect(body.memories.map(m => m.id).sort()).toEqual([m1, m2].sort());
  });

  it('excludes superseded and archived memories — only the currently-valid link surfaces (review fix HIGH)', async () => {
    const memRepo = new MemoryRepo(db);
    const events = new MemoryEventRepo(db);
    const entities = new EntityRepo(db);
    const superseded = seedMemory(memRepo, 'postgres old fact', 'h-ev-1');
    const successor = seedMemory(memRepo, 'postgres new fact', 'h-ev-2'); // supersede target, not entity-linked
    const archived = seedMemory(memRepo, 'postgres archived fact', 'h-ev-3');
    const live = seedMemory(memRepo, 'postgres live fact', 'h-ev-4');
    const pgId = entities.upsert('postgres', 'tech');
    entities.link(superseded, pgId);
    entities.link(archived, pgId);
    entities.link(live, pgId);

    events.supersede(superseded, successor); // FEAT-402 AC-3 also unlinks superseded's memory_entities row
    events.archive(archived); // archive keeps the memory_entities row, but sets valid_to

    const res = await app.inject({
      method: 'GET', url: `/entities/${pgId}/memories`,
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { memories: Array<{ id: string }> };
    expect(body.memories.map(m => m.id)).toEqual([live]);
  });

  it('returns 404 for an unknown entity id', async () => {
    const res = await app.inject({
      method: 'GET', url: '/entities/does-not-exist/memories',
      headers: { authorization: 'Bearer tok' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 401 without a Bearer token', async () => {
    const entities = new EntityRepo(db);
    const pgId = entities.upsert('postgres', 'tech');
    const res = await app.inject({ method: 'GET', url: `/entities/${pgId}/memories` });
    expect(res.statusCode).toBe(401);
  });
});
