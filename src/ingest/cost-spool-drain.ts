/**
 * FEAT-476 Phase 0 — drains `src/capture/cost-spool.ts`'s file-based queue
 * into `cost_events` (src/storage/cost-events.ts `recordCostEvent`).
 * Mirrors `src/ingest/spool-drain.ts`'s own shape (filesystem-driven tick,
 * not a `jobs` row — draining is "list spool/*.json", not event-driven) —
 * see that module's doc for the full rationale, which applies identically
 * here.
 */
import { childLogger } from '../log/logger.js';
import type { DB } from '../storage/db.js';
import { recordCostEvent } from '../storage/cost-events.js';
import { listCostSpoolFiles, readCostSpoolEntry, deleteCostSpoolFile } from '../capture/cost-spool.js';

export interface CostSpoolDrainResult {
  drained: number;
  failed: number;
  pending: number;
}

export function drainCostSpool(db: DB, dataDir: string, maxPerTick = 200): CostSpoolDrainResult {
  const log = childLogger({ request_id: 'cost-spool-drain' });
  const files = listCostSpoolFiles(dataDir);
  const batch = files.slice(0, maxPerTick);

  let drained = 0;
  let failed = 0;

  for (const file of batch) {
    const entry = readCostSpoolEntry(file.path);
    if (!entry) {
      log.warn({ file: file.name }, 'cost-spool-drain: unreadable spool file, discarding');
      deleteCostSpoolFile(file.path);
      failed++;
      continue;
    }
    try {
      recordCostEvent(db, entry);
      deleteCostSpoolFile(file.path);
      drained++;
    } catch (err) {
      // Fail-loud in the log, but never abort the whole tick over one bad
      // row — same "one poison item never blocks the rest of the batch"
      // posture as drainIngestSpool's quarantine handling. Left on disk
      // (NOT deleted) so a transient DB error (e.g. a mid-migration boot
      // race) gets a retry on the next tick instead of silently losing the
      // fact.
      log.warn({ file: file.name, err: err instanceof Error ? err.message : String(err) }, 'cost-spool-drain: recordCostEvent failed, will retry next tick');
      failed++;
    }
  }

  return { drained, failed, pending: files.length - batch.length };
}
