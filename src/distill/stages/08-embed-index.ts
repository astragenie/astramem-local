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
import { MemoryEventRepo } from '../../storage/memory-events.js';
import { EntityRepo } from '../../storage/entities.js';
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
  /**
   * Canonical envelope's `captured_at` (epoch ms), when the ingest route
   * received one (v1.0 envelope only — legacy v0.0 has no such field).
   * Becomes each new memory's `valid_from` so bitemporal `as_of` queries key
   * off when the content was true, not when this distill job happened to
   * run. `null`/omitted falls back to MemoryRepo's insert-time wall-clock
   * default — the pre-existing behavior for legacy envelopes and any
   * pre-fix rows (no migration backfills those; see distill.ts/distill-events.ts).
   */
  capturedAtMs?: number | null;
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
  const eventsRepo = new MemoryEventRepo(ctx.db);
  const entityRepo = new EntityRepo(ctx.db);
  const vecStore = new SqliteVecStore(ctx.db, ctx.embed.dim);

  // Batch embed all texts at once for efficiency
  const texts = memories.map(m => m.normalizedText);
  const vectors = await ctx.embed.embed(texts);

  const results: IndexResult[] = [];

  for (let i = 0; i < memories.length; i++) {
    const mem = memories[i];
    const vec = vectors[i];

    if (!mem) continue;
    if (!vec || vec.length !== ctx.embed.dim) {
      throw new Error(
        `embed provider returned dim=${vec?.length ?? 0} for memory ${i}, expected ${ctx.embed.dim}. ` +
        `This is a provider invariant violation — check config.embedding.provider and model.`
      );
    }

    // Erasure replay filter (ADR-006 W5): an erased content hash must never
    // be resurrected by re-distillation — erasure wins over replay.
    if (eventsRepo.isErasedHash(mem.finalHash)) continue;

    // Insert + append a 'create' memory_event (ADR-002) in one transaction.
    // Dedup-aware: `created` is false when this hash already existed.
    const { id: memoryId, created } = memRepo.insertWithCreateEvent({
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
      evidence: mem.evidence ?? null,
      scope: 'private',
      valid_from: ctx.capturedAtMs ?? undefined,
      // atom@2: stage 5 always runs entity extraction as part of this same
      // atom's LLM call, so every atom from this pipeline has "declared"
      // entities even when it found none — default to [] (not undefined)
      // so the sync payload signals "tried, found nothing" rather than
      // "extraction never ran" (see InsertInput.entities doc).
      entities: mem.entities ?? [],
    }, eventsRepo);

    // FEAT-402 AC-1: link entities emitted in the same extraction call.
    // Idempotent (INSERT OR IGNORE on the memory_id/entity_id PK) so this is
    // safe to run on a deduped hit too — backfills entities for a memory
    // that pre-existed before this feature shipped, on its next re-ingest.
    entityRepo.linkEntitiesForMemory(memoryId, mem.entities);

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
