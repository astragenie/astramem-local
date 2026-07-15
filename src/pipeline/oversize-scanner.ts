/**
 * FEAT-507 — oversize-atom repair scanner.
 *
 * Finds memories that are BOTH oversize (see oversize.ts) and still flagged
 * `needs_vec_index` (issue #209's durable "not vector-indexed yet" marker —
 * cleared only on a successful embed/upsert), and enqueues a `reembed` job
 * for each one that doesn't already have a pending/running `reembed` job in
 * flight. reembedHandler's truncate-before-embed fix (see handlers/
 * reembed.ts) is what actually repairs these once the job runs.
 *
 * This is a dedicated, shorter-cadence sweep on top of the existing generic
 * 24h `cleanup` job vec-index sweep (src/pipeline/handlers/cleanup.ts) —
 * that sweep would eventually re-enqueue every still-flagged row too, but
 * production was observed accumulating oversize poisons at ~16/hr; waiting
 * up to a day to repair them is too slow. This scanner also gives oversize
 * repairs their own observable counters, separate from the generic sweep.
 *
 * Idempotent by construction (FEAT-507 requirement): `hasPendingOrRunningReembedJob`
 * skips a memory that already has an in-flight repair job, so re-running
 * this scan mid-drain (or on the next timer tick before a prior pass's jobs
 * have finished) never double-enqueues the same atom. A memory that
 * successfully repairs also drops out of the candidate set on the next scan
 * (`needs_vec_index` is cleared on success — see reembedHandler).
 */

import type { DB } from '../storage/db.js';
import { MemoryRepo } from '../storage/memories.js';
import { JobRepo } from './job-repo.js';
import { EMBED_MAX_INPUT_CHARS } from './oversize.js';

/**
 * Cap on how many oversize memories one scan pass enqueues — mirrors
 * cleanup.ts's VEC_INDEX_SWEEP_LIMIT (500) so a large backlog drains
 * gradually across scan ticks instead of flooding the job queue in one pass.
 */
export const OVERSIZE_SCAN_LIMIT = 500;

export interface OversizeScanResult {
  /** Oversize + needs_vec_index candidates found this pass (before the
   *  already-queued filter below), capped at `limit`. */
  candidates: number;
  /** New `reembed` jobs enqueued this pass. */
  enqueued: number;
  /** Candidates skipped because a pending/running `reembed` job already
   *  exists for that memory — the idempotency guarantee in action. */
  alreadyQueued: number;
}

export function scanAndEnqueueOversizeRepairs(db: DB, limit: number = OVERSIZE_SCAN_LIMIT): OversizeScanResult {
  const memRepo = new MemoryRepo(db);
  const jobRepo = new JobRepo(db);

  const candidateIds = memRepo.listOversizeNeedingVecIndex(EMBED_MAX_INPUT_CHARS, limit);

  let enqueued = 0;
  let alreadyQueued = 0;
  for (const memoryId of candidateIds) {
    if (hasPendingOrRunningReembedJob(db, memoryId)) {
      alreadyQueued++;
      continue;
    }
    jobRepo.enqueue('reembed', { kind: 'reembed', memory_id: memoryId });
    enqueued++;
  }

  return { candidates: candidateIds.length, enqueued, alreadyQueued };
}

/**
 * True when a `reembed` job for `memoryId` is already pending or running.
 * `jobs.payload_json` is always written by this codebase's own `JobRepo.enqueue`
 * (JSON.stringify) — never fed by an external/sync source the way
 * `memory_events.payload_json` is — so this reads it directly with
 * `json_extract` rather than going through `storage/json-guard.ts`'s
 * malformed-JSON guard (precedent: migration 018's own partial index reads
 * `jobs.payload_json` the same way).
 */
function hasPendingOrRunningReembedJob(db: DB, memoryId: string): boolean {
  const row = db.prepare(`
    SELECT 1 FROM jobs
    WHERE kind = 'reembed'
      AND state IN ('pending', 'running')
      AND json_extract(payload_json, '$.memory_id') = ?
    LIMIT 1
  `).get(memoryId);
  return row !== undefined;
}
