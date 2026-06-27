import { ReembedPayloadSchema } from '../../contracts/index.js';
import type { JobHandler, HandlerCtx } from '../handler.js';

/**
 * Reembed handler — STUB (Wave 3/D will replace with provider-backed embedding).
 *
 * Wave 3 + Track D wire in an EmbedProvider and VectorStore to actually
 * re-compute and upsert the embedding for the given memory_id.
 *
 * For now: validates the payload, logs, and completes successfully.
 */
export const reembedHandler: JobHandler = {
  kind: 'reembed',

  async handle(payload: unknown, _ctx: HandlerCtx): Promise<void> {
    const parsed = ReembedPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid reembed payload: ${parsed.error.message}`);
    }

    const { memory_id } = parsed.data;
    console.log(`[reembed] STUB — memory_id=${memory_id} (Wave 3 + Track D will implement)`);
    // Wave 3: replace with embed.embed([memory.text]) → vector.upsert(memory_id, vec)
  }
};
