/**
 * Purge-batch reversible soft-delete routes (FEAT-467, ADR-013 Decision 4 —
 * hard prerequisite for FEAT-458's proxy capture tier). Design settled in
 * docs/specs/FEAT-458-S1-design.md §1.
 *
 *   POST /capture/purge { capture_source, restore_window_days? }
 *     -> 200 { batch_id, count } | 400 | 401
 *   POST /capture/purge/:batchId/restore -> 200 { restored } | 401 | 404 | 409
 *   POST /capture/purge/:batchId/finalize -> 200 { erased }   | 401 | 404 | 409
 *
 * `capture_source` is a plain scoping parameter with no branching in this
 * route or in `MemoryEventRepo.purgeBatch()` itself (FEAT-467 AC-5) — today
 * only `'auto_capture'` has a caller (`runAutoCaptureDisable`,
 * src/cli/capture.ts, retrofitted onto this route in the same change that
 * added it), `'proxy'` is FEAT-458's future disable flow reusing this
 * unmodified. Error-status mapping reuses `mapLifecycleError`
 * (server/routes/lifecycle.ts) unchanged — no new error-status convention.
 */

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { DB } from '../../storage/db.js';
import { MemoryEventRepo } from '../../storage/memory-events.js';
import { mapLifecycleError } from './lifecycle.js';
import type { Config } from '../../config/config.js';

const PurgeBodySchema = z.object({
  capture_source: z.string().min(1),
  // nonnegative (not positive): 0 is a valid "no restore grace period" value
  // for an operator/sweep override, not a malformed request.
  restore_window_days: z.number().nonnegative().optional(),
});

export function capturePurgeRoutes(db: DB, config: Config) {
  return async (app: FastifyInstance) => {
    const events = new MemoryEventRepo(db);

    app.post('/capture/purge', async (req, reply) => {
      const parsed = PurgeBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid', details: parsed.error.flatten() });
      }
      const { capture_source: captureSource, restore_window_days: restoreWindowDays } = parsed.data;
      const rows = db
        .prepare('SELECT id FROM memories WHERE capture_source = ? AND valid_to IS NULL')
        .all(captureSource) as { id: string }[];
      const result = events.purgeBatch(
        rows.map(r => r.id),
        captureSource,
        restoreWindowDays ?? config.capture.purge.restoreWindowDays,
      );
      return { batch_id: result.batchId, count: result.count };
    });

    app.post('/capture/purge/:batchId/restore', async (req, reply) => {
      const { batchId } = req.params as { batchId: string };
      try {
        const result = events.restorePurgeBatch(batchId);
        return { restored: result.restored };
      } catch (err) {
        return mapLifecycleError(err, batchId, reply);
      }
    });

    app.post('/capture/purge/:batchId/finalize', async (req, reply) => {
      const { batchId } = req.params as { batchId: string };
      try {
        const result = events.finalizePurgeBatch(batchId);
        return { erased: result.erased };
      } catch (err) {
        return mapLifecycleError(err, batchId, reply);
      }
    });
  };
}
