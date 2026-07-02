// Wave 4e — usefulness feeds ranking (ADR-010 v1.x): the ε fusion component.

import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import {
  usefulnessScores,
  recordRecallUsed,
  recordRecallServed,
  recordMemoryCorrected,
} from '../../src/storage/usefulness.js';
import { fuseScores } from '../../src/search/fuse.js';
import { search, makeFakeVec } from '../../src/search/search.js';
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

describe('usefulnessScores (ADR-010 ranking signal)', () => {
  let db: DB;

  beforeEach(() => {
    db = openDb(':memory:');
    migrate(db);
  });

  it('returns neutral 0.5 for atoms with no signal, and an entry for every requested id', () => {
    const a = seed(db, 'alpha', 'h-ur-1');
    const scores = usefulnessScores(db, [a, 'nonexistent-id']);
    expect(scores.get(a)).toBe(0.5);
    expect(scores.get('nonexistent-id')).toBe(0.5);
    expect(usefulnessScores(db, []).size).toBe(0);
  });

  it('recall_used lifts the score, memory_corrected drops it (Laplace smoothing)', () => {
    const up = seed(db, 'useful one', 'h-ur-2');
    const down = seed(db, 'corrected one', 'h-ur-3');
    recordRecallUsed(db, { atomId: up, surface: 'mcp', signal: 'explicit' });
    recordMemoryCorrected(db, { atomId: down, action: 'superseded' });

    const scores = usefulnessScores(db, [up, down]);
    expect(scores.get(up)).toBeCloseTo(2 / 3); // (1+1)/(1+0+2)
    expect(scores.get(down)).toBeCloseTo(1 / 3); // (0+1)/(0+1+2)
  });

  it('recall_served events do not move the score (served ≠ useful)', () => {
    const a = seed(db, 'served only', 'h-ur-4');
    recordRecallServed(db, { query: 'served only', atomIds: [a], surface: 'rest' });
    expect(usefulnessScores(db, [a]).get(a)).toBe(0.5);
  });
});

describe('fuseScores ε component', () => {
  const base = { normBm25: 1, normCosine: 0, importance: 0.5, freshness: 1, alpha: 0.4, beta: 0.4, gamma: 0.1, delta: 0.1 };

  it('omitted epsilon ignores usefulness entirely (back-compat)', () => {
    expect(fuseScores({ ...base, usefulness: 1 })).toBe(fuseScores({ ...base, usefulness: 0 }));
  });

  it('with epsilon, higher usefulness scores strictly higher', () => {
    const lifted = fuseScores({ ...base, epsilon: 0.1, usefulness: 2 / 3 });
    const neutral = fuseScores({ ...base, epsilon: 0.1 }); // defaults to 0.5
    const dropped = fuseScores({ ...base, epsilon: 0.1, usefulness: 1 / 3 });
    expect(lifted).toBeGreaterThan(neutral);
    expect(neutral).toBeGreaterThan(dropped);
  });
});

describe('search ranking end-to-end', () => {
  it('recall_used breaks the tie between otherwise-identical memories', async () => {
    const db = openDb(':memory:');
    migrate(db);
    // Same text → identical BM25, importance, freshness; only ε differs.
    const plain = seed(db, 'deployment runbook for the edge cluster', 'h-ur-e2e-1');
    const boosted = seed(db, 'deployment runbook for the edge cluster', 'h-ur-e2e-2');
    recordRecallUsed(db, { atomId: boosted, surface: 'rest', signal: 'explicit' });

    const hits = await search('deployment runbook', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const ids = hits.map(h => h.id);
    expect(ids).toContain(plain);
    expect(ids).toContain(boosted);
    expect(ids.indexOf(boosted)).toBeLessThan(ids.indexOf(plain));
  });

  it('memory_corrected demotes below an unsignaled twin', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const plain = seed(db, 'staging credentials rotation policy', 'h-ur-e2e-3');
    const demoted = seed(db, 'staging credentials rotation policy', 'h-ur-e2e-4');
    recordMemoryCorrected(db, { atomId: demoted, action: 'demoted' });

    const hits = await search('credentials rotation', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    const ids = hits.map(h => h.id);
    expect(ids.indexOf(plain)).toBeLessThan(ids.indexOf(demoted));
  });
});
