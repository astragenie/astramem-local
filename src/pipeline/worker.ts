import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import type { HandlerCtx } from './handler.js';
import type { HandlerRegistry } from './registry.js';
import { JobRepo } from './job-repo.js';
import { DistillBudgetPausedError } from './handlers/distill.js';
import { classifyError } from './failure-classifier.js';
import { logger, childLogger } from '../log/logger.js';

const MAX_ATTEMPTS = 3;

export interface WorkerOpts {
  pollMs: number;
  registry: HandlerRegistry;
  db: DB;
  config: Config;
  /** Optional pre-built HandlerCtx (or ExtendedHandlerCtx) to pass to handlers.
   *  When omitted, a minimal {db, config} context is constructed. */
  ctx?: HandlerCtx;
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
  const ctx: HandlerCtx = opts.ctx ?? { db, config };

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

    // Build a per-job child logger; binds job_id + job_kind + attempt on every log line
    const jobLog = childLogger({ job_id: job.id, job_kind: job.kind, attempt: job.attempts + 1 });
    jobLog.info('job claimed');

    const handler = registry.get(job.kind);

    if (!handler) {
      // No handler registered — treat as a permanent failure
      const errMsg = `No handler registered for job kind '${job.kind}'`;
      repo.fail(job.id, errMsg);
      const updated = repo.get(job.id);
      if (updated) {
        if (updated.attempts >= MAX_ATTEMPTS) {
          repo.markPoison(job.id);
          jobLog.warn({ error_message: errMsg, error_kind: 'NoHandler' }, 'job poisoned — no handler');
        } else {
          repo.requeueForRetry(job.id);
          jobLog.warn({ error_message: errMsg, error_kind: 'NoHandler' }, 'job requeued — no handler');
        }
      }
      scheduleNext();
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(job.payload_json);
    } catch (e) {
      const errMsg = `Failed to parse payload_json: ${String(e)}`;
      repo.fail(job.id, errMsg);
      const updated = repo.get(job.id);
      if (updated) {
        if (updated.attempts >= MAX_ATTEMPTS) {
          repo.markPoison(job.id);
          jobLog.warn({ error_message: errMsg, error_kind: 'PayloadParseError' }, 'job poisoned — bad payload');
        } else {
          repo.requeueForRetry(job.id);
          jobLog.warn({ error_message: errMsg, error_kind: 'PayloadParseError' }, 'job requeued — bad payload');
        }
      }
      scheduleNext();
      return;
    }

    try {
      await handler.handle(payload, ctx);
      repo.complete(job.id);
      jobLog.info('job completed');
    } catch (err) {
      // Budget exceeded → pause the job (not a failure, not retried).
      // Do NOT call fail() — that would increment attempts and eventually
      // poison the job after repeated daily cap hits, preventing recovery
      // when the user runs `astra-memory budget --reset`.
      if (DistillBudgetPausedError.is(err)) {
        const errMsg = err instanceof Error ? err.message : String(err);
        repo.setLastError(job.id, errMsg);
        repo.pause(job.id);
        jobLog.warn({ error_message: errMsg, error_kind: 'BudgetPaused' }, 'job paused — budget exceeded');
        scheduleNext();
        return;
      }

      const kind = classifyError(err);
      const errMsg = err instanceof Error ? err.message : String(err);

      if (kind === 'deterministic') {
        // Schema / parse failures will not self-heal with another LLM call.
        // Poison immediately to avoid burning budget on retries.
        repo.fail(job.id, errMsg);
        repo.markPoison(job.id);
        jobLog.warn({ error_message: errMsg.slice(0, 200), error_kind: 'DeterministicFailure' }, 'job poisoned — deterministic failure');
      } else {
        // Transient failure — retry with exponential backoff up to MAX_ATTEMPTS.
        repo.fail(job.id, errMsg);
        const updated = repo.get(job.id);
        if (updated && updated.attempts >= MAX_ATTEMPTS) {
          repo.markPoison(job.id);
          jobLog.warn({ error_message: errMsg.slice(0, 200), error_kind: 'TransientFailure', attempts: updated.attempts }, 'job poisoned — retries exhausted');
        } else {
          // Exponential backoff: 1s, 2s, 4s, … capped at 60s
          const attemptsSoFar = updated?.attempts ?? 1;
          const delay = Math.min(1000 * Math.pow(2, attemptsSoFar - 1), 60_000);
          jobLog.info({ error_message: errMsg.slice(0, 200), delay_ms: delay }, 'job requeued for retry');
          setTimeout(() => { repo.requeueForRetry(job.id); }, delay);
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
    const errMsg = err instanceof Error ? err.message : String(err);
    logger.error({ error_message: errMsg.slice(0, 200), error_kind: err instanceof Error ? err.name : 'Unknown' }, '[worker] uncaught error in tick');
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
