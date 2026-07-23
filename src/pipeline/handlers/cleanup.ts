import { CleanupPayloadSchema } from '../../contracts/index.js';
import { ts } from '../../log/logger.js';
import type { JobHandler, HandlerCtx } from '../handler.js';
import { runArchivalPass } from '../../storage/archival.js';
import { pruneIngestIdempotency } from '../../storage/ingest-idempotency.js';
import { runImplicitPositivePass, pruneOldRecallServedEvents } from '../../storage/usefulness.js';
import { runRetentionPass, writeSweepStats } from '../../storage/retention.js';
import { MemoryRepo } from '../../storage/memories.js';
import { JobRepo } from '../job-repo.js';

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
 *
 * Wave-3 storage+perf track: also prunes `memory_events` 'usefulness'/
 * 'recall_served' rows older than `config.memoryEvents.recallServedRetentionDays`
 * (default 30 days) — see src/storage/usefulness.ts's
 * `pruneOldRecallServedEvents` for the full safe predicate (already-synced
 * rows only; never unsynced or any non-usefulness event_type).
 *
 * issue #190: also runs the implicit positive-usefulness sweep
 * (`runImplicitPositivePass`, src/storage/usefulness.ts) on the same
 * cadence — config.search.usefulness.implicitPositive.enabled === false
 * (the default) makes it a hard no-op, same posture as archival above.
 *
 * FEAT-493: also runs the tiered disk-artifact retention pass
 * (src/storage/retention.ts's `runRetentionPass`) on the same cadence, using
 * `config.retention.tier` as the active Media/Lean/All dial —
 * config.retention.mode === 'off' (the default) makes it a no-op, same
 * posture as archival above. This pass NEVER touches `memories` rows (that
 * axis is archival.ts's exclusive domain — arch-review boundary, 2026-07-14)
 * — it only ever unlinks files under `<dataDir>/artifacts/<kind>/`. Sweep
 * results are persisted via `writeSweepStats` for the doctor "last sweep"
 * stat (src/doctor/checks/retention.ts).
 *
 * Issue #209: also the durable safety net for the vec-index retry drain —
 * every memory still flagged `needs_vec_index = 1` (a write-time vec upsert
 * that failed, or a pre-existing orphan backfilled by migrations/041-vec-
 * index-retry.sql) gets a `reembed` job enqueued on this same pass. This
 * catches the case where the immediate write-time enqueue (08-embed-index.ts
 * / POST /remember / MCP remember) itself failed or never ran (e.g. every
 * pre-migration orphan, which was never enqueued by anything). Piggybacking
 * on this existing 24h tick rather than adding a new timer follows ADR-015's
 * explicit guidance (§4) to reuse an existing cadence instead of inventing a
 * tight new one for a background drain. Capped per pass (VEC_INDEX_SWEEP_LIMIT)
 * so a large backlog drains gradually rather than flooding the job queue.
 */
/** Issue #209: max needs_vec_index rows swept into `reembed` jobs per cleanup
 *  pass — a conservative cap, not a tuned one; production has seen 13. */
const VEC_INDEX_SWEEP_LIMIT = 500;

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

    // FEAT-493: disk-artifact retention. 'off' (the default) never touches
    // the filesystem at all — matches archival's no-op posture above.
    if (ctx.config.retention.mode !== 'off') {
      const retention = runRetentionPass(ctx.config.dataDir, ctx.config.retention, ctx.config.retention.tier);
      writeSweepStats(ctx.config.dataDir, retention);
      if (retention.candidates.length > 0) {
        console.log(
          `${ts()} [cleanup] retention pass (${retention.mode}/${retention.tier}): ` +
          `${retention.deleted.length}/${retention.candidates.length} candidate(s) reclaimed ` +
          `(${retention.deletedBytes} of ${retention.totalBytes} bytes)` +
          (retention.errors.length > 0 ? `, ${retention.errors.length} error(s)` : ''),
        );
      }
    }

    const idempotency = pruneIngestIdempotency(ctx.db, ctx.config);
    if (idempotency.pruned > 0) {
      console.log(
        `${ts()} [cleanup] pruned ${idempotency.pruned} ingest_idempotency row(s) older than ` +
        `${ctx.config.ingestIdempotency.retentionDays} day(s)`,
      );
    }

    // Wave-3 storage+perf track: memory_events 'usefulness'/'recall_served'
    // retention. Only already-synced rows older than the TTL are ever
    // deleted — see pruneOldRecallServedEvents's doc comment for the full
    // HARD INVARIANT (never touches unsynced/create/invalidate/supersede/
    // promote_scope/erase_request rows).
    const recallServedPrune = pruneOldRecallServedEvents(ctx.db, ctx.config.memoryEvents.recallServedRetentionDays);
    if (recallServedPrune.pruned > 0) {
      console.log(
        `${ts()} [cleanup] pruned ${recallServedPrune.pruned} synced recall_served event(s) older than ` +
        `${ctx.config.memoryEvents.recallServedRetentionDays} day(s)`,
      );
    }

    // issue #190: implicit positive-usefulness sweep — off unless the
    // operator opted in AND the config-load-time eval-evidence gate
    // (applyFusionGovernance) let `enabled` stay true.
    if (ctx.config.search.usefulness.implicitPositive.enabled) {
      const implicitPositive = runImplicitPositivePass(ctx.db, {
        windowDays: ctx.config.search.usefulness.implicitPositive.windowDays,
        minDistinctQueries: ctx.config.search.usefulness.implicitPositive.minDistinctQueries,
        maxGrantsPerRun: ctx.config.search.usefulness.implicitPositive.maxGrantsPerRun,
      });
      if (implicitPositive.granted > 0) {
        console.log(
          `${ts()} [cleanup] implicit positive pass: ${implicitPositive.granted}/${implicitPositive.candidates} ` +
          `atoms granted heuristic usefulness credit`,
        );
      }
    }

    // Issue #209: sweep every memory still flagged needs_vec_index and
    // enqueue a reembed job for it. A row stays flagged until reembedHandler
    // clears it on a successful retry, so re-sweeping a row that already has
    // a pending/running job just enqueues a harmless extra attempt — cheap
    // at this volume (13 in production today) and simpler than tracking
    // per-memory in-flight state.
    const memRepo = new MemoryRepo(ctx.db);
    const jobRepo = new JobRepo(ctx.db);
    const needingIndex = memRepo.listNeedingVecIndex(VEC_INDEX_SWEEP_LIMIT);
    for (const memoryId of needingIndex) {
      jobRepo.enqueue('reembed', { kind: 'reembed', memory_id: memoryId });
    }
    if (needingIndex.length > 0) {
      console.log(
        `${ts()} [cleanup] vec-index sweep: enqueued ${needingIndex.length} reembed job(s) for memories flagged needs_vec_index`,
      );
    }
  }
};
