import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import type { DB } from '../../src/storage/db.js';

describe('MemoryRepo', () => {
  let db: DB;
  let repo: MemoryRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
    repo = new MemoryRepo(db);
  });

  it('inserts and reads by id', () => {
    const id = repo.insert({
      type: 'decision',
      text: 'use sqlite-vec for v1',
      normalized_text: 'use sqlite-vec for v1',
      repo: 'astramemory-local',
      hash: 'h1',
      session_id: null,
      project: null,
      branch: null,
      agent: null,
      source_hash: null
    });
    const m = repo.get(id);
    expect(m?.text).toBe('use sqlite-vec for v1');
    expect(m?.type).toBe('decision');
  });

  it('hash dedup — second insert with same hash returns existing id', () => {
    const id1 = repo.insert({
      type: 'fact', text: 't', normalized_text: 't', hash: 'dup',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const id2 = repo.insert({
      type: 'fact', text: 't', normalized_text: 't', hash: 'dup',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    expect(id1).toBe(id2);
  });

  it('fts5 search finds inserted memory', () => {
    repo.insert({
      type: 'decision', text: 'use postgres for sync', normalized_text: 'use postgres for sync', hash: 'p1',
      repo: null, project: null, branch: null, agent: null, session_id: null, source_hash: null
    });
    const hits = repo.searchFts('postgres', 10);
    expect(hits.length).toBe(1);
    expect(hits[0].text).toContain('postgres');
  });
});
