// P2 retrieval-overhaul plan (2026-07-20): "Rerank `query + atom text +
// evidence excerpt`, not atom text alone." rerank.ts's buildRerankCandidateText
// already read `hit.evidence` — this covers the search.ts producer side: does
// search() actually populate SearchHit.evidence, with the right precedence
// (evidence_span > legacy evidence), does the rerank stage's candidate text
// pick it up, and does toWireHit keep it off the closed POST /recall envelope.

import { describe, it, expect, vi } from 'vitest';
import { openDb, type DB } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { search, makeFakeVec } from '../../src/search/search.js';
import { toWireHit } from '../../src/contracts/wire-hit.js';
import type { RerankOpts, CrossEncoderProvider } from '../../src/search/rerank.js';
import type { EmbedProvider } from '../../src/contracts/index.js';
import { defaultConfig } from '../../src/config/config.js';

const fakeEmbed: EmbedProvider = {
  name: 'ollama' as const,
  model: 'fake',
  dim: 1024 as const,
  embed: async (texts: string[]) => texts.map(t => makeFakeVec(t)),
  health: async () => ({ ok: true, model: 'fake', dim: 1024 as const }),
};

function setupDb(): DB {
  const db = openDb(':memory:');
  migrate(db);
  return db;
}

async function seedWithVec(
  db: DB,
  text: string,
  hash: string,
  extra: { evidence?: string | null; evidence_span?: string | null } = {},
): Promise<string> {
  const id = new MemoryRepo(db).insert({
    type: 'fact', text, normalized_text: text.toLowerCase(),
    repo: 'r1', project: null, branch: null, agent: null,
    session_id: null, hash, source_hash: null,
    ...extra,
  });
  const vecStore = new SqliteVecStore(db, fakeEmbed.dim);
  const [vec] = await fakeEmbed.embed([text]);
  await vecStore.upsert(id, vec as Float32Array);
  return id;
}

describe('search() evidence-excerpt threading onto SearchHit (P2 retrieval overhaul)', () => {
  it('populates hit.evidence from evidence_span when present', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'ev-1', {
      evidence: 'paraphrased excerpt',
      evidence_span: 'exact transcript span',
    });

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits[0]!.evidence).toBe('exact transcript span');
  });

  it('falls back to the legacy evidence string when evidence_span is absent', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'ev-2', {
      evidence: 'paraphrased excerpt',
      evidence_span: null,
    });

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits[0]!.evidence).toBe('paraphrased excerpt');
  });

  it('leaves evidence undefined when the memory has neither field', async () => {
    const db = setupDb();
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'ev-3');

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect('evidence' in hits[0]!).toBe(false);
  });

  it('bounds the excerpt to MAX_EVIDENCE_EXCERPT_CHARS (500)', async () => {
    const db = setupDb();
    const longSpan = 'x'.repeat(900);
    await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'ev-4', {
      evidence_span: longSpan,
    });

    const hits = await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search,
    });
    expect(hits[0]!.evidence).toHaveLength(500);
  });

  it('rerank stage candidate text includes the evidence excerpt (the buildRerankCandidateText hook actually fires)', async () => {
    const db = setupDb();
    const idA = await seedWithVec(db, 'sqlite-vec hybrid bm25 fusion search', 'ev-5', {
      evidence_span: 'the exact source line quoting this fact',
    });
    await seedWithVec(db, 'completely unrelated banana bread recipe', 'ev-6');

    const spyScore = vi.fn(async (_query: string, candidates: { id: string; text: string }[]) => {
      const map = new Map<string, number>();
      candidates.forEach(c => map.set(c.id, 0.5));
      return map;
    });
    const provider: CrossEncoderProvider = { name: 'mock', score: spyScore };
    const rerank: RerankOpts = { topK: 50, timeoutMs: 300, provider };

    await search('sqlite-vec hybrid search', {}, 10, {
      db, embed: fakeEmbed, weights: defaultConfig().search, rerank,
    });

    expect(spyScore).toHaveBeenCalledTimes(1);
    const [, calledCandidates] = spyScore.mock.calls[0]!;
    const candidateA = calledCandidates.find(c => c.id === idA)!;
    expect(candidateA.text).toContain('Evidence: the exact source line quoting this fact');
  });
});

describe('toWireHit strips evidence from the closed POST /recall envelope', () => {
  it('omits evidence even when SearchHit carries one', () => {
    const wire = toWireHit({
      id: 'x', type: 'fact', text: 't', score: 0.5, source: 'both',
      scope: 'private', importance: 0.5, confidence: 0.5,
      created_at: new Date(0).toISOString(),
      explanation: { final: 0.5, signals: {} },
      evidence: 'should not leak onto the wire',
    } as never);
    expect((wire as Record<string, unknown>).evidence).toBeUndefined();
    expect('evidence' in (wire as Record<string, unknown>)).toBe(false);
  });
});
