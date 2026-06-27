import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { embedAndIndex } from '../../src/distill/stages/08-embed-index.js';
import type { NormalizedMemory } from '../../src/distill/stages/07-memory-normalize.js';
import type { EmbedProvider, EmbedHealth } from '../../src/contracts/index.js';
import type { DB } from '../../src/storage/db.js';

function makeVec(seed: number): Float32Array {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed + i * 0.01);
  return v;
}

function makeMockEmbed(dim: number = 1024): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'test-embed-model',
    dim: 1024 as const,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => makeVec(i + 1));
    },
    async health(): Promise<EmbedHealth> {
      return { ok: true, model: 'test-embed-model', dim };
    },
  };
}

function normalizedMem(text: string, hash: string, importance = 0.7): NormalizedMemory {
  return {
    type: 'decision',
    text,
    normalizedText: text.trim().toLowerCase(),
    importance,
    confidence: 0.8,
    contentHash: hash.slice(0, 16),
    finalHash: hash,
    evidence: undefined,
  };
}

describe('embedAndIndex stage', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('inserts a memory and creates a vec row', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('use sqlite-vec for v1', 'a'.repeat(64))];

    const results = await embedAndIndex(mems, {
      db,
      embed,
      sessionId: null,
      repo: 'astramemory-local',
      project: null,
      branch: null,
      agent: null,
      sourceHash: null,
    });

    expect(results.length).toBe(1);
    expect(results[0].created).toBe(true);
    expect(typeof results[0].memoryId).toBe('string');

    // Verify row in memories table
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(results[0].memoryId) as any;
    expect(row).toBeTruthy();
    expect(row.embedding_provider).toBe('ollama');
    expect(row.embedding_model).toBe('test-embed-model');
    expect(row.embedding_dim).toBe(1024);

    // Verify vec row exists
    const vecRow = db.prepare('SELECT rowid FROM memories_vec WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)').get(results[0].memoryId) as any;
    expect(vecRow).toBeTruthy();
  });

  it('deduplicates by hash — second insert returns created=false', async () => {
    const embed = makeMockEmbed();
    const mems = [normalizedMem('same memory text', 'b'.repeat(64))];

    const r1 = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });
    const r2 = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    expect(r1[0].created).toBe(true);
    expect(r2[0].created).toBe(false);
    expect(r1[0].memoryId).toBe(r2[0].memoryId);
  });

  it('handles multiple memories in a batch', async () => {
    const embed = makeMockEmbed();
    const mems = [
      normalizedMem('first decision', 'c'.repeat(64)),
      normalizedMem('second fact', 'd'.repeat(64)),
      normalizedMem('third lesson', 'e'.repeat(64)),
    ];

    const results = await embedAndIndex(mems, { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });

    expect(results.length).toBe(3);
    expect(results.every(r => r.created)).toBe(true);

    const count = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as any).n;
    expect(count).toBe(3);
  });

  it('returns empty array for empty input', async () => {
    const embed = makeMockEmbed();
    const results = await embedAndIndex([], { db, embed, sessionId: null, repo: null, project: null, branch: null, agent: null, sourceHash: null });
    expect(results).toEqual([]);
  });

  it('attaches session and repo metadata', async () => {
    const embed = makeMockEmbed();
    // Need a session row first for FK
    db.prepare('INSERT INTO sessions (id, started_at) VALUES (?, ?)').run('sess-1', Date.now());

    const mems = [normalizedMem('architecture decision', 'f'.repeat(64))];
    const results = await embedAndIndex(mems, {
      db, embed,
      sessionId: 'sess-1',
      repo: 'my-repo',
      project: 'my-project',
      branch: 'main',
      agent: 'claude-code',
      sourceHash: 'src123',
    });

    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(results[0].memoryId) as any;
    expect(row.session_id).toBe('sess-1');
    expect(row.repo).toBe('my-repo');
    expect(row.agent).toBe('claude-code');
  });
});
