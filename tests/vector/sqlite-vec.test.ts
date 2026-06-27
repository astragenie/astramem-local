import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { MemoryRepo } from '../../src/storage/memories.js';

function vec(seed: number): Float32Array {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed + i * 0.01);
  return v;
}

function makeMemory(repo: MemoryRepo, hash: string): string {
  return repo.insert({
    type: 'fact', text: hash, normalized_text: hash, hash,
    repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
  });
}

describe('SqliteVecStore', () => {
  it('upserts a vector and returns it via search', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const store = new SqliteVecStore(db);
    const repo = new MemoryRepo(db);
    const id1 = makeMemory(repo, 'm1');
    const id2 = makeMemory(repo, 'm2');
    await store.upsert(id1, vec(1));
    await store.upsert(id2, vec(100));
    const hits = await store.search(vec(1), 1);
    expect(hits[0].id).toBe(id1);
    expect(hits[0].score).toBeGreaterThan(0);
  });

  it('orders by similarity', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const store = new SqliteVecStore(db);
    const repo = new MemoryRepo(db);
    const idA = makeMemory(repo, 'a');
    const idB = makeMemory(repo, 'b');
    const idC = makeMemory(repo, 'c');
    await store.upsert(idA, vec(1));
    await store.upsert(idB, vec(1.01));
    await store.upsert(idC, vec(50));
    const hits = await store.search(vec(1), 3);
    expect(hits[0].id).toBe(idA);
    expect(hits[1].id).toBe(idB);
    expect(hits[2].id).toBe(idC);
  });
});
