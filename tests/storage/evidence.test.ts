import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { embedAndIndex } from '../../src/distill/stages/08-embed-index.js';
import { reduce } from '../../src/distill/stages/06-reduce.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { EmbedProvider } from '../../src/contracts/index.js';

function fakeEmbed(): EmbedProvider {
  return {
    name: 'ollama' as const,
    model: 'fake',
    dim: 1024 as const,
    embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
    health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
  };
}

describe('evidence persistence (AM-1)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('insert stores evidence and get returns it', () => {
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'decision',
      text: 'Use SQLite, not Postgres',
      normalized_text: 'use SQLite, not PostgreSQL',
      repo: 'astramem-local', project: null, branch: null, agent: null,
      session_id: null, hash: 'h-evidence-1', source_hash: null,
      evidence: 'we decided sqlite because zero-config local file',
    });
    const mem = repo.get(id);
    expect(mem?.evidence).toBe('we decided sqlite because zero-config local file');
  });

  it('insert without evidence stores null (old-row degradation)', () => {
    const repo = new MemoryRepo(db);
    const id = repo.insert({
      type: 'fact', text: 'port 7777 default', normalized_text: 'port 7777 default',
      repo: null, project: null, branch: null, agent: null,
      session_id: null, hash: 'h-evidence-2', source_hash: null,
    });
    expect(repo.get(id)?.evidence).toBeNull();
  });

  it('stage 8 (embedAndIndex) passes evidence through to storage', async () => {
    const results = await embedAndIndex(
      [{
        type: 'lesson',
        text: 'Bun lacks better-sqlite3 on Windows',
        importance: 0.8,
        confidence: 0.9,
        evidence: 'install failed with node-gyp error in session log',
        contentHash: 'ch-1',
        normalizedText: 'Bun lacks better-sqlite3 on Windows',
        finalHash: 'h-evidence-3',
      }],
      {
        db, embed: fakeEmbed(),
        sessionId: null, repo: 'r1', project: null, branch: null, agent: null,
        sourceHash: null,
      },
    );
    expect(results).toHaveLength(1);
    const stored = new MemoryRepo(db).get(results[0]!.memoryId);
    expect(stored?.evidence).toBe('install failed with node-gyp error in session log');
  });

  it('stage 6 (reduce) preserves the winning atom evidence (architect finding #3)', () => {
    const out = reduce([
      { type: 'decision', text: 'Use SQLite', importance: 0.5, confidence: 0.8, evidence: 'low-importance evidence' },
      { type: 'decision', text: 'use sqlite', importance: 0.9, confidence: 0.9, evidence: 'winning evidence' },
    ]);
    expect(out).toHaveLength(1);   // same content hash after normalization
    expect(out[0]?.evidence).toBe('winning evidence');
  });
});
