// Quick win #3 — reembed handler un-stubbed: real embed + vector upsert.

import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/storage/db.js';
import { migrate } from '../../src/storage/migrate.js';
import { MemoryRepo } from '../../src/storage/memories.js';
import { SqliteVecStore } from '../../src/vector/sqlite-vec.js';
import { reembedHandler } from '../../src/pipeline/handlers/reembed.js';
import { defaultConfig } from '../../src/config/config.js';
import { makeFakeVec } from '../../src/search/search.js';
import type { ExtendedHandlerCtx } from '../../src/pipeline/handler-ctx-ext.js';
import type { EmbedProvider, LLMProvider } from '../../src/contracts/index.js';

function makeCtx(db: ReturnType<typeof openDb>): { ctx: ExtendedHandlerCtx; embedCalls: string[][] } {
  const embedCalls: string[][] = [];
  const embed: EmbedProvider = {
    name: 'ollama' as const,
    model: 'reembed-test-model',
    dim: 1024 as const,
    embed: async (texts: string[]) => {
      embedCalls.push(texts);
      return texts.map(t => makeFakeVec(`v2:${t}`));
    },
    health: async () => ({ ok: true, model: 'reembed-test-model', dim: 1024 as const }),
  };
  const llm = { name: 'ollama', model: 'x', complete: async () => '' } as unknown as LLMProvider;
  const ctx: ExtendedHandlerCtx = {
    db,
    config: defaultConfig(),
    providers: { llm: { compaction: llm, extraction: llm }, embed },
    memoryRepo: new MemoryRepo(db),
    vecStore: new SqliteVecStore(db),
  };
  return { ctx, embedCalls };
}

describe('reembed handler', () => {
  it('recomputes the vector and records the provider/model on the memory', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { ctx, embedCalls } = makeCtx(db);

    const id = new MemoryRepo(db).insert({
      type: 'fact', text: 'port is 7777', normalized_text: 'port is 7777',
      repo: 'r1', project: null, branch: null, agent: null,
      session_id: null, hash: 'h-re-1', source_hash: null,
    });
    await ctx.vecStore.upsert(id, makeFakeVec('old vector'));

    await reembedHandler.handle({ kind: 'reembed', memory_id: id }, ctx);

    expect(embedCalls).toEqual([['port is 7777']]);
    const row = db.prepare('SELECT embedding_model, embedding_provider, embedding_dim FROM memories WHERE id = ?')
      .get(id) as { embedding_model: string; embedding_provider: string; embedding_dim: number };
    expect(row).toEqual({ embedding_model: 'reembed-test-model', embedding_provider: 'ollama', embedding_dim: 1024 });

    // New vector actually replaced the old one — nearest hit for the new text wins.
    const hits = await ctx.vecStore.search(makeFakeVec('v2:port is 7777'), 1);
    expect(hits[0]?.id).toBe(id);
    expect(hits[0]?.score).toBeCloseTo(1, 5);
  });

  it('missing memory is a clean success (erased between enqueue and run)', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { ctx, embedCalls } = makeCtx(db);
    await expect(reembedHandler.handle({ kind: 'reembed', memory_id: 'gone' }, ctx)).resolves.toBeUndefined();
    expect(embedCalls).toHaveLength(0);
  });

  it('rejects bad payloads and non-extended contexts', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { ctx } = makeCtx(db);
    await expect(reembedHandler.handle({ nope: true }, ctx)).rejects.toThrow(/Invalid reembed payload/);
    await expect(reembedHandler.handle(
      { kind: 'reembed', memory_id: 'x' },
      { db, config: defaultConfig() },
    )).rejects.toThrow(/extended handler context/);
  });

  // Issue #209: reembed is the retry mechanism a failed inline vec upsert
  // (08-embed-index.ts / POST /remember / MCP remember) enqueues itself as.
  // This proves the "subsequently retried and becomes searchable" half of
  // the fix — the "does not report success" half is proven at the
  // write-site level in tests/distill/08-embed-index.test.ts.
  it('clears needs_vec_index and makes the memory vector-searchable after a prior failure', async () => {
    const db = openDb(':memory:');
    migrate(db);
    const { ctx } = makeCtx(db);

    const memRepo = new MemoryRepo(db);
    const id = memRepo.insert({
      type: 'fact', text: 'a memory whose vec upsert failed at write time', normalized_text: 'a memory whose vec upsert failed',
      repo: null, project: null, branch: null, agent: null, session_id: null, hash: 'h-re-vecidx-1', source_hash: null,
    });
    // Simulate the write-time failure path's durable marker — no memories_vec
    // row exists yet for this id.
    memRepo.markNeedsVecIndex(id);
    expect(memRepo.get(id)?.needs_vec_index).toBe(true);
    await expect(ctx.vecStore.search(makeFakeVec('v2:a memory whose vec upsert failed at write time'), 5))
      .resolves.not.toContainEqual(expect.objectContaining({ id }));

    await reembedHandler.handle({ kind: 'reembed', memory_id: id }, ctx);

    expect(memRepo.get(id)?.needs_vec_index).toBe(false);
    const hits = await ctx.vecStore.search(makeFakeVec('v2:a memory whose vec upsert failed at write time'), 5);
    expect(hits.some(h => h.id === id)).toBe(true);
  });
});
