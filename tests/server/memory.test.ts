import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
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

describe('GET /memory/:id', () => {
  let db: DB;
  let repo: MemoryRepo;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
    app = await buildApp({ db, token: 'tok', embed: buildMockEmbed() });
  });

  it('returns full memory record by id', async () => {
    const id = repo.insert({
      type: 'decision',
      text: 'store vectors in sqlite-vec',
      normalized_text: 'store vectors in sqlite-vec',
      repo: 'astramemory-local',
      project: 'wave2',
      branch: 'main',
      agent: 'claude-code',
      session_id: null,
      hash: 'test-hash-001',
      source_hash: null,
      importance: 0.9,
      confidence: 0.85
    });

    const res = await app.inject({
      method: 'GET',
      url: `/memory/${id}`,
      headers: { authorization: 'Bearer tok' }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(id);
    expect(body.type).toBe('decision');
    expect(body.text).toBe('store vectors in sqlite-vec');
    expect(body.repo).toBe('astramemory-local');
    expect(body.project).toBe('wave2');
    expect(body.importance).toBeCloseTo(0.9);
    expect(body.confidence).toBeCloseTo(0.85);
    expect(typeof body.created_at).toBe('number');
    expect(typeof body.updated_at).toBe('number');
  });

  it('returns 404 for unknown id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/memory/non-existent-id-xyz',
      headers: { authorization: 'Bearer tok' }
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBeDefined();
  });

  it('returns 401 without bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/memory/some-id'
    });
    expect(res.statusCode).toBe(401);
  });
});
