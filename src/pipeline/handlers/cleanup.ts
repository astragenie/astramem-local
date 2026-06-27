import { CleanupPayloadSchema } from '../../contracts/index.js';
import type { JobHandler, HandlerCtx } from '../handler.js';

/**
 * Cleanup handler — IMPLEMENTED.
 *
 * Prunes jobs in the 'completed' state whose updated_at is older than
 * `older_than_days` (default 30). Other states (pending, running, failed,
 * poison, paused) are never touched so the operator can inspect them.
 */
export const cleanupHandler: JobHandler = {
  kind: 'cleanup',

  async handle(payload: unknown, ctx: HandlerCtx): Promise<void> {
    const parsed = CleanupPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`Invalid cleanup payload: ${parsed.error.message}`);
    }

    const { older_than_days } = parsed.data;
    const cutoffMs = Date.now() - older_than_days * 24 * 60 * 60 * 1000;

    const result = ctx.db.prepare(`
      DELETE FROM jobs
      WHERE state = 'completed'
        AND updated_at < ?
    `).run(cutoffMs);

    console.log(`[cleanup] pruned ${result.changes} completed job(s) older than ${older_than_days} day(s)`);
  }
};
