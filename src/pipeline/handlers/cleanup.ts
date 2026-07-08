import { CleanupPayloadSchema } from '../../contracts/index.js';
import { ts } from '../../log/logger.js';
import type { JobHandler, HandlerCtx } from '../handler.js';
import { runArchivalPass } from '../../storage/archival.js';
import { pruneIngestIdempotency } from '../../storage/ingest-idempotency.js';

/**
 * Cleanup handler — IMPLEMENTED.
 *
 * Prunes jobs in the 'completed' state whose updated_at is older than
 * `older_than_days` (default 30). Other states (pending, running, failed,
 * poison, paused) are never touched so the operator can inspect them.
 *
 * Also runs the memory TTL/archival policy pass (FEAT-404) on the same
 * cadence — config.archival.enabled === false (the default) makes it a
 * no-op, so existing cleanup-job behavior is unchanged unless an operator
 * opts in.
 *
 * FEAT-432: also prunes `ingest_idempotency` rows older than
 * `config.ingestIdempotency.retentionDays` (default 7 days) on the same
 * pass — see src/storage/ingest-idempotency.ts for the replay-safety
 * rationale behind that default.
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

    // Poison jobs are kept 30 days for `queue` forensics, then purged —
    // without this they accumulate forever (nothing else ever re-reads them).
    const POISON_RETENTION_DAYS = 30;
    const poisonCutoffMs = Date.now() - POISON_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const poisonResult = ctx.db.prepare(`
      DELETE FROM jobs
      WHERE state = 'poison'
        AND updated_at < ?
    `).run(poisonCutoffMs);

    console.log(
      `${ts()} [cleanup] pruned ${result.changes} completed job(s) older than ${older_than_days} day(s), ` +
      `${poisonResult.changes} poison job(s) older than ${POISON_RETENTION_DAYS} day(s)`,
    );

    const archival = runArchivalPass(ctx.db, ctx.config);
    if (archival.candidates > 0) {
      console.log(
        `${ts()} [cleanup] archival pass: ${archival.archived}/${archival.candidates} stale low-usefulness ` +
        `memories archived`,
      );
    }

    const idempotency = pruneIngestIdempotency(ctx.db, ctx.config);
    if (idempotency.pruned > 0) {
      console.log(
        `${ts()} [cleanup] pruned ${idempotency.pruned} ingest_idempotency row(s) older than ` +
        `${ctx.config.ingestIdempotency.retentionDays} day(s)`,
      );
    }
  }
};
