import { ReembedPayloadSchema } from '../../contracts/index.js';
import type { JobHandler, HandlerCtx } from '../handler.js';
import { isExtendedCtx } from '../handler-ctx-ext.js';

/**
 * Reembed handler — recompute + upsert the embedding for one memory
 * (`rebuild` CLI enqueues one job per memory; model swaps re-index this way).
 *
 * A missing memory is a success, not a failure: the memory may have been
 * erased (ADR-006) or superseded-and-cleaned between enqueue and execution,
 * and retrying would never make it reappear.
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
      console.log(`[reembed] memory ${memory_id} no longer exists — skipping`);
      return;
    }

    const [vec] = await ctx.providers.embed.embed([memory.text]);
    if (!vec) throw new Error(`embed provider returned no vector for memory ${memory_id}`);
    await ctx.vecStore.upsert(memory_id, vec);

    ctx.db.prepare(
      'UPDATE memories SET embedding_provider = ?, embedding_model = ?, embedding_dim = ?, updated_at = ? WHERE id = ?',
    ).run(ctx.providers.embed.name, ctx.providers.embed.model, ctx.providers.embed.dim, Date.now(), memory_id);
  }
};
