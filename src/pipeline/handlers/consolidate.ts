/**
 * `consolidate` job handler — scheduled/queued entry point for the ADR-004
 * stage 9 pass. The pass itself is deterministic and synchronous (no LLM in
 * v1); this wrapper exists so consolidation can ride the jobs table like
 * every other pipeline stage.
 */

import { z } from 'zod';
import type { JobHandler } from '../handler.js';
import { runConsolidation } from '../../consolidate/consolidate.js';

const ConsolidatePayloadSchema = z.object({
  merge_threshold: z.number().min(0).max(1).optional(),
  propose_threshold: z.number().min(0).max(1).optional(),
});

export const consolidateHandler: JobHandler = {
  kind: 'consolidate',
  async handle(payload, ctx): Promise<void> {
    const parsed = ConsolidatePayloadSchema.parse(payload ?? {});
    runConsolidation(ctx.db, {
      mergeThreshold: parsed.merge_threshold,
      proposeThreshold: parsed.propose_threshold,
    });
  },
};
