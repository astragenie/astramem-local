import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, CheckResult } from '../types.js';
import type { DB } from '../../storage/db.js';
import { summarizeHandlerRuns } from '../../storage/handler-run-log.js';
import { openProductionDbReadonly } from './shared.js';

// ─── Check: Pipeline handler run-log (FEAT-495 item 4a) ──────────────────────

/** Registered job-handler kinds (src/pipeline/registry.ts / src/cli/serve.ts's
 *  registry.register() calls) — kept here as a plain list rather than
 *  importing HandlerRegistry, since doctor runs against a readonly DB
 *  snapshot with no live registry instance to introspect. */
const KNOWN_HANDLER_KINDS = ['distill', 'distill-events', 'cleanup', 'consolidate', 'reembed'] as const;

/**
 * Reads `handler_runs` (migration 047, src/storage/handler-run-log.ts),
 * written by src/pipeline/worker.ts at each terminal outcome of a handler
 * invocation. Makes two failure shapes visible that were previously only
 * discoverable by noticing missing memories or a growing poison-job count:
 *
 *  - a registered handler kind with ZERO rows ever — "built, wired, never
 *    invoked" (e.g. `reembed` only runs when explicitly triggered by an
 *    operator, so this is expected for it and flagged only informationally).
 *  - a handler whose most recent run FAILED — surfaced per-handler, not just
 *    as an aggregate poison count with no breakdown of which pipeline stage
 *    is broken.
 */
export function checkHandlerRunLog(dataDir: string, encryptionEnabled: boolean): Check {
  return {
    name: 'Pipeline handler run-log',
    tier: 'cheap',
    async run(): Promise<CheckResult> {
      const dbPath = join(dataDir, 'memory.sqlite');
      if (!existsSync(dbPath)) {
        return { ok: true, message: 'handler run-log: no DB yet' };
      }

      let db: DB | undefined;
      try {
        db = await openProductionDbReadonly(dbPath, encryptionEnabled);
        const summaries = summarizeHandlerRuns(db);
        const byHandler = new Map(summaries.map(s => [s.handler, s]));

        const neverInvoked = KNOWN_HANDLER_KINDS.filter(k => !byHandler.has(k));
        const recentlyFailed = summaries.filter(s => s.lastStatus === 'failed');

        if (summaries.length === 0) {
          return {
            ok: true,
            message: 'handler run-log: no handler runs recorded yet (fresh install, or the worker has not ticked)',
          };
        }

        if (recentlyFailed.length > 0) {
          const detail = recentlyFailed
            .map(s => `${s.handler} (${s.lastErrorType ?? 'unknown'}: ${(s.lastErrorMessage ?? '').slice(0, 120)})`)
            .join('; ');
          return {
            ok: false,
            message: `handler run-log: ${recentlyFailed.length} handler(s) failed on their MOST RECENT run — ${detail}`,
            fix: 'Check the ingest.log around that handler\'s last run for the underlying error — a run of consecutive failures for one handler is worth investigating even if the job queue eventually poisons and stops retrying.',
          };
        }

        const summaryLine = summaries
          .map(s => `${s.handler}: ${s.lastStatus} (${s.totalRuns} run(s), ${s.totalFailed} failed all-time)`)
          .join(', ');
        const neverNote = neverInvoked.length > 0
          ? ` — never invoked: ${neverInvoked.join(', ')} (expected for handlers that only run when explicitly triggered, e.g. reembed)`
          : '';

        return { ok: true, message: `handler run-log: ${summaryLine}${neverNote}` };
      } catch (err) {
        // The query itself failed — did NOT verify handler run-log is healthy.
        return { ok: true, inconclusive: true, message: `handler run-log check error (non-fatal): ${err}` };
      } finally {
        db?.close();
      }
    },
  };
}
