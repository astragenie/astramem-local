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
});
