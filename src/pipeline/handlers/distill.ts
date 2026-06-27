import { DistillPayloadSchema } from '../../contracts/index.js';
import type { JobHandler, HandlerCtx } from '../handler.js';

/**
 * Distill handler — STUB (Wave 3 will replace with 8-stage pipeline).
 *
 * Wave 3 replaces this with the full distillation pipeline:
 *   cleanup → normalize → chunk → compact (LLM) → extract (LLM) →
 *   reduce → memory-normalize → embed + index
 *
 * For now: validates the payload, logs, and completes successfully.
 */
export const distillHandler: JobHandler = {
  kind: 'distill',

  async handle(payload: unknown, _ctx: HandlerCtx): Promise<void> {
    const parsed = DistillPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid distill payload: ${parsed.error.message}`);
    }

    const { transcript_id, session_id } = parsed.data;
    console.log(`[distill] STUB — transcript_id=${transcript_id} session_id=${session_id} (Wave 3 will implement)`);
    // Wave 3: replace this body with pipeline.run({ transcript_id, session_id }, ctx)
  }
};
