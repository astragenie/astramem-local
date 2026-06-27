/**
 * Stage 8 — Embed + Index (provider call + DB writes)
 *
 * For each normalized memory:
 * 1. Insert into memories table via MemoryRepo.insert (hash dedup built in)
 * 2. Embed the normalizedText via EmbedProvider
 * 3. Upsert vec row via SqliteVecStore.upsert
 * 4. Update embedding_provider/model/dim on the memories row
 */

import type { EmbedProvider } from '../../contracts/index.js';
import type { NormalizedMemory } from './07-memory-normalize.js';
import { MemoryRepo } from '../../storage/memories.js';
import { SqliteVecStore } from '../../vector/sqlite-vec.js';
import type { DB } from '../../storage/db.js';

export interface IndexResult {
  memoryId: string;
  created: boolean; // false = deduped (already existed)
}

export interface EmbedIndexContext {
  db: DB;
  embed: EmbedProvider;
  sessionId: string | null;
  repo: string | null;
  project: string | null;
  branch: string | null;
  agent: string | null;
  sourceHash: string | null;
}

/**
 * Embed and index all normalized memories.
 * Returns one IndexResult per input atom (some may be deduped by hash).
 */
export async function embedAndIndex(
  memories: NormalizedMemory[],
  ctx: EmbedIndexContext,
): Promise<IndexResult[]> {
  if (memories.length === 0) return [];

  const memRepo = new MemoryRepo(ctx.db);
  const vecStore = new SqliteVecStore(ctx.db);

  // Batch embed all texts at once for efficiency
  const texts = memories.map(m => m.normalizedText);
  const vectors = await ctx.embed.embed(texts);

  const results: IndexResult[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const vec = vectors[i];

    if (!vec || vec.length !== 1024) {
      console.warn(`[embed-index] memory ${i} got dim=${vec?.length ?? 0}, expected 1024 — skipping`);
      continue;
    }

    // Check if this hash already exists
    const existingRow = ctx.db
      .prepare('SELECT id FROM memories WHERE hash = ?')
      .get(mem.finalHash) as { id: string } | undefined;

    const memoryId = memRepo.insert({
      type: mem.type,
      text: mem.text,
      normalized_text: mem.normalizedText,
      hash: mem.finalHash,
      importance: mem.importance,
      confidence: mem.confidence,
      session_id: ctx.sessionId,
      repo: ctx.repo,
      project: ctx.project,
      branch: ctx.branch,
      agent: ctx.agent,
      source_hash: ctx.sourceHash,
      embedding_provider: ctx.embed.name,
      embedding_model: ctx.embed.model,
      embedding_dim: ctx.embed.dim,
    });

    const created = !existingRow;

    // Always upsert vec (may update if the memory already existed but had no vec)
    await vecStore.upsert(memoryId, vec);

    // Update embedding metadata on the memories row (in case it pre-existed without it)
    ctx.db
      .prepare(`
        UPDATE memories
        SET embedding_provider = ?, embedding_model = ?, embedding_dim = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(ctx.embed.name, ctx.embed.model, ctx.embed.dim, Date.now(), memoryId);

    results.push({ memoryId, created });
  }

  return results;
}
