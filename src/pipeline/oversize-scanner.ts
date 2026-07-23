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
 * Dedup guard (FEAT-507 requirement): `listActiveReembedMemoryIds` skips a
 * memory that already has a job in any non-terminal state (`pending`,
 * `running`, `failed` awaiting retry, or `paused`), so re-running this scan
 * mid-drain (or on the next timer tick before a prior pass's jobs have
 * finished, or within a `failed` job's backoff window before it self-promotes
 * back to `pending` — see worker.ts) never double-enqueues the same atom. A
 * memory that successfully repairs also drops out of the candidate set on
 * the next scan (`needs_vec_index` is cleared on success — see reembedHandler).
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
  const activeReembedMemoryIds = listActiveReembedMemoryIds(db);

  let enqueued = 0;
  let alreadyQueued = 0;
  for (const memoryId of candidateIds) {
    if (activeReembedMemoryIds.has(memoryId)) {
      alreadyQueued++;
      continue;
    }
    jobRepo.enqueue('reembed', { kind: 'reembed', memory_id: memoryId });
    enqueued++;
  }

  return { candidates: candidateIds.length, enqueued, alreadyQueued };
}

/**
 * Every memory id with a `reembed` job in any non-terminal state, as a Set —
 * ONE query up front instead of a per-candidate `SELECT` (up to
 * `OVERSIZE_SCAN_LIMIT` = 500 `SCAN jobs` per hourly tick, the N+1 this
 * replaces; see docs/specs/20260723-codebase-refactor-plan.md). Terminal
 * states are `completed` and `poison` (see job-repo.ts); everything else
 * (`pending`, `running`, `failed`, `paused`) will still be retried by the
 * worker, so it counts as "already has a job in flight" for dedup purposes —
 * a `failed` job sitting in its exponential-backoff window before
 * self-promoting back to `pending` must not be re-enqueued by this scan.
 * `jobs.payload_json` is always written by this codebase's own `JobRepo.enqueue`
 * (JSON.stringify) — never fed by an external/sync source the way
 * `memory_events.payload_json` is — so this reads it directly with
 * `json_extract` rather than going through `storage/json-guard.ts`'s
 * malformed-JSON guard (precedent: migration 018's own partial index reads
 * `jobs.payload_json` the same way).
 */
function listActiveReembedMemoryIds(db: DB): Set<string> {
  const rows = db.prepare(`
    SELECT DISTINCT json_extract(payload_json, '$.memory_id') AS memory_id
    FROM jobs
    WHERE kind = 'reembed' AND state NOT IN ('completed', 'poison')
  `).all() as { memory_id: string | null }[];
  return new Set(rows.map(r => r.memory_id).filter((id): id is string => id !== null));
}
