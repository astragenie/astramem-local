import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import type { HandlerCtx } from './handler.js';
import type { HandlerRegistry } from './registry.js';
import { JobRepo } from './job-repo.js';
import { DistillBudgetPausedError } from './handlers/distill.js';

const MAX_ATTEMPTS = 3;

export interface WorkerOpts {
  pollMs: number;
  registry: HandlerRegistry;
  db: DB;
  config: Config;
}

export interface WorkerHandle {
  stop(): void;
}

/**
 * Start the worker poll loop in-process.
 *
 * Each tick:
 *   1. Claim the oldest pending job (atomic state transition pending→running).
 *   2. Dispatch to the registered handler.
 *   3. On success → complete.
 *   4. On throw → fail + attempts++. If attempts >= MAX_ATTEMPTS → poison.
 *   5. Repeat immediately if a job was found; otherwise sleep pollMs.
 *
 * Returns a handle with stop() that terminates the loop after the current tick.
 */
export function startWorker(opts: WorkerOpts): WorkerHandle {
  const { pollMs, registry, db, config } = opts;
  const repo = new JobRepo(db);
  const ctx: HandlerCtx = { db, config };

  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function tick(): Promise<void> {
    if (stopped) return;

    const job = repo.claimPending();

    if (!job) {
      // Nothing to do — schedule next poll
      if (!stopped) {
        timer = setTimeout(() => { tick().catch(onUncaught); }, pollMs);
      }
      return;
    }

    const handler = registry.get(job.kind);

    if (!handler) {
      // No handler registered — treat as a permanent failure
      const errMsg = `No handler registered for job kind '${job.kind}'`;
      repo.fail(job.id, errMsg);
      const updated = repo.get(job.id);
      if (updated) {
        if (updated.attempts >= MAX_ATTEMPTS) {
          repo.markPoison(job.id);
        } else {
          repo.requeueForRetry(job.id);
        }
      }
      scheduleNext();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(job.payload_json);
    } catch (e) {
      repo.fail(job.id, `Failed to parse payload_json: ${String(e)}`);
      const updated = repo.get(job.id);
      if (updated) {
        if (updated.attempts >= MAX_ATTEMPTS) {
          repo.markPoison(job.id);
        } else {
          repo.requeueForRetry(job.id);
        }
      }
      scheduleNext();
      return;
    }

    try {
      await handler.handle(payload, ctx);
      repo.complete(job.id);
    } catch (err) {
      // Budget exceeded → pause the job (not a failure, not retried)
      if (DistillBudgetPausedError.is(err)) {
        const errMsg = err instanceof Error ? err.message : String(err);
        repo.fail(job.id, errMsg);
        repo.pause(job.id);
        scheduleNext();
        return;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      repo.fail(job.id, errMsg);
      // Re-fetch to get the updated attempts count
      const updated = repo.get(job.id);
      if (updated) {
        if (updated.attempts >= MAX_ATTEMPTS) {
          repo.markPoison(job.id);
        } else {
          // Put back in pending so the worker will retry
          repo.requeueForRetry(job.id);
        }
      }
    }

    scheduleNext();
  }

  function scheduleNext(): void {
    if (!stopped) {
      // Run next tick on next event loop turn (avoid deep call stacks)
      timer = setTimeout(() => { tick().catch(onUncaught); }, 0);
    }
  }

  function onUncaught(err: unknown): void {
    // Worker must not crash the process — log and keep polling
    console.error('[worker] uncaught error in tick:', err);
    if (!stopped) {
      timer = setTimeout(() => { tick().catch(onUncaught); }, pollMs);
    }
  }

  // Kick off the first tick
  timer = setTimeout(() => { tick().catch(onUncaught); }, 0);

  return {
    stop(): void {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}
