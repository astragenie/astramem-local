import { ReembedPayloadSchema } from '../../contracts/index.js';
import { ts } from '../../log/logger.js';
import type { JobHandler, HandlerCtx } from '../handler.js';
import { isExtendedCtx } from '../handler-ctx-ext.js';
import { truncateForEmbedding, embedWithOversizeGuard } from '../oversize.js';

/**
 * Reembed handler — recompute + upsert the embedding for one memory
 * (`rebuild` CLI enqueues one job per memory; model swaps re-index this way.
 * Issue #209: also the retry mechanism for a memory whose inline vec upsert
 * failed at write time — see 08-embed-index.ts / POST /remember / MCP
 * remember, which all enqueue this same job kind on failure instead of
 * inventing a separate retry path).
 *
 * A missing memory is a success, not a failure: the memory may have been
 * erased (ADR-006) or superseded-and-cleaned between enqueue and execution,
 * and retrying would never make it reappear.
 *
 * FEAT-507: oversize atoms (giant transcript atoms, backfill-promoted
 * legacy rows) were poisoning this handler at a steady rate in production —
 * the embed provider deterministically fails a "context length exceeded"
 * 500, but the worker retried it 3x like any other failure before giving
 * up. Fixed two ways (see oversize.ts): truncate to the embed context
 * budget BEFORE calling the provider (cheap default — a lossy embedding
 * beats none), and reclassify any context-length overflow that still slips
 * through as deterministic so the worker poisons immediately instead of
 * burning wasted retries.
 */
export const reembedHandler: JobHandler = {
  kind: 'reembed',

  async handle(payload: unknown, ctx: HandlerCtx): Promise<void> {
    const parsed = ReembedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid reembed payload: ${parsed.error.message}`);
    }
    if (!isExtendedCtx(ctx)) {
      throw new Error('reembed requires the extended handler context (providers + vecStore)');
    }

    const { memory_id } = parsed.data;
    const memory = ctx.memoryRepo.get(memory_id);
    if (!memory) {
      console.log(`${ts()} [reembed] memory ${memory_id} no longer exists — skipping`);
      return;
    }

    const { text: embedText, truncated } = truncateForEmbedding(memory.text);
    if (truncated) {
      console.warn(
        `${ts()} [reembed] memory ${memory_id} text (${memory.text.length} chars) exceeds the embed ` +
        `context budget — truncated to ${embedText.length} chars before embedding`,
      );
    }

    const [vec] = await embedWithOversizeGuard(embedText, ctx.providers.embed, memory_id, memory.text.length);
    if (!vec) throw new Error(`embed provider returned no vector for memory ${memory_id}`);
    await ctx.vecStore.upsert(memory_id, vec);

    ctx.db.prepare(
      'UPDATE memories SET embedding_provider = ?, embedding_model = ?, embedding_dim = ?, updated_at = ? WHERE id = ?',
    ).run(ctx.providers.embed.name, ctx.providers.embed.model, ctx.providers.embed.dim, Date.now(), memory_id);

    // Issue #209: this upsert succeeded, so the retry marker (if this job
    // was enqueued because a prior attempt failed) is stale — clear it. A
    // no-op for the pre-existing `rebuild` CLI path, where the row was
    // never flagged in the first place.
    ctx.memoryRepo.clearNeedsVecIndex(memory_id);
  }
};
