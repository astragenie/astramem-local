import type { DB } from '../storage/db.js';
import type { Config } from '../config/config.js';
import type { HandlerCtx } from './handler.js';
import type { HandlerRegistry } from './registry.js';
import { JobRepo } from './job-repo.js';
import { DistillBudgetPausedError } from './handlers/distill.js';
import { classifyError } from './failure-classifier.js';
import { logger, childLogger } from '../log/logger.js';

const MAX_ATTEMPTS = 3;

/** Hard bounds for `config.pipeline.concurrency`. Clamped (never fatal) so a
 *  bad/hand-edited config value can't block daemon boot or run an unbounded
 *  number of lanes. */
const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;

/**
 * Resolve the number of worker lanes to run from config, clamped to
 * [MIN_CONCURRENCY, MAX_CONCURRENCY]. Non-finite/non-positive/non-integer
 * values fall back to 1 (the pre-concurrency default) rather than throwing —
 * a malformed config must never block daemon boot.
 *
 * Exported for tests; production only ever calls this via startWorker.
 */
export function resolveWorkerConcurrency(config: Config): number {
  const raw = config.pipeline?.concurrency;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return MIN_CONCURRENCY;
  const truncated = Math.trunc(raw);
  return Math.min(MAX_CONCURRENCY, Math.max(MIN_CONCURRENCY, truncated || MIN_CONCURRENCY));
}

export interface WorkerOpts {
  pollMs: number;
  registry: HandlerRegistry;
  db: DB;
  config: Config;
  /** Optional pre-built HandlerCtx (or ExtendedHandlerCtx) to pass to handlers.
   *  When omitted, a minimal {db, config} context is constructed. */
  ctx?: HandlerCtx;
  /** Optional liveness sink — the worker stamps lastTickAt each tick so
   *  /health can report worker.alive. */
  healthState?: { worker: { lastTickAt: number | null } };
}

export interface WorkerHandle {
  /**
   * Stop the worker. Resolves AFTER every lane's currently in-flight tick
   * completes (if any). Callers MUST await this before closing the DB —
   * otherwise better-sqlite3 may throw SQLITE_MISUSE if a handler is still
   * writing.
   */
  stop(): Promise<void>;
}

/**
 * Start the worker poll loop in-process.
 *
 * Runs `resolveWorkerConcurrency(config)` independent claim-execute lanes
 * (default 1 — byte-identical to the pre-concurrency single-loop worker).
 * Each lane runs the exact same tick loop below and all lanes share one
 * `JobRepo` bound to the same `db`, so lanes race on the SAME atomic
 * pending→running claim (`JobRepo.claimPending`) rather than each getting
 * their own queue — no job can be claimed by two lanes. That claim is safe
 * under concurrency by construction: better-sqlite3 is synchronous and
 * `claimPending()` runs its SELECT+UPDATE inside a single `db.transaction()`
 * call with no `await` inside, so — because Node.js is single-threaded — no
 * other lane's tick can interleave in the middle of a claim. Two lanes
 * calling `claimPending()` "at the same time" from the event loop's
 * perspective still execute one after the other at the C/SQLite level; the
 * second lane's UPDATE always sees `state != 'pending'` for a row the first
 * already claimed and gets `changes === 0`, so `claimPending()` returns null
 * for it (falls through to the next candidate on its next tick). This was
 * already true for MAX_ATTEMPTS-poisoning single-lane retries racing a
 * boot-time orphan-recovery pass; concurrency just adds more callers onto
 * the same guarantee.
 *
 * Each lane's tick:
 *   1. Claim the oldest pending job (atomic state transition pending→running).
 *   2. Dispatch to the registered handler.
 *   3. On success → complete.
 *   4. On throw → fail + attempts++. If attempts >= MAX_ATTEMPTS → poison.
 *   5. Repeat immediately if a job was found; otherwise sleep pollMs.
 *
 * Concurrency > 1 multiplies local Ollama load — each lane can have an
 * in-flight LLM/embed call at the same time, so raising this without also
 * raising Ollama's own concurrency cap just serializes lanes behind Ollama
 * instead of the job queue. Pair a `pipeline.concurrency > 1` config with the
 * `OLLAMA_NUM_PARALLEL` environment variable on the Ollama server (see
 * https://ollama.com — Ollama defaults to 1 in-flight request per model).
 *
 * Returns a handle with stop() that terminates every lane after its
 * currently in-flight tick.
 */
export function startWorker(opts: WorkerOpts): WorkerHandle {
  const { pollMs, registry, db, config } = opts;
  const repo = new JobRepo(db);
  const ctx: HandlerCtx = opts.ctx ?? { db, config };
  const concurrency = resolveWorkerConcurrency(config);

  // Shared across all lanes: stop() flips this once, every lane's tick/onUncaught
  // checks it before scheduling further work.
  let stopped = false;

  interface Lane {
    stop(): Promise<void>;
  }

  function createLane(laneId: number): Lane {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight: Promise<void> | null = null;

    async function tick(): Promise<void> {
      if (stopped) return;
      if (opts.healthState) opts.healthState.worker.lastTickAt = Date.now();

      const job = repo.claimPending();

      if (!job) {
        // Nothing to do — schedule next poll
        if (!stopped) {
          timer = setTimeout(() => { launchTick(); }, pollMs);
        }
        return;
      }

      // Build a per-job child logger; binds job_id + job_kind + attempt + lane
      // on every log line (lane distinguishes concurrent-execution log lines
      // when concurrency > 1).
      const jobLog = childLogger({ job_id: job.id, job_kind: job.kind, attempt: job.attempts + 1, lane: laneId });
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
        timer = setTimeout(() => { launchTick(); }, 0);
      }
    }

    function onUncaught(err: unknown): void {
      // Worker must not crash the process — log and keep polling
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ error_message: errMsg.slice(0, 200), error_kind: err instanceof Error ? err.name : 'Unknown', lane: laneId }, '[worker] uncaught error in tick');
      if (!stopped) {
        timer = setTimeout(() => { launchTick(); }, pollMs);
      }
    }

    /**
     * Wraps tick() so the resulting promise is tracked in `inFlight`.
     * stop() awaits this promise to ensure no handler is mid-DB-write when
     * the caller subsequently closes the database.
     */
    function launchTick(): void {
      inFlight = tick().catch(onUncaught).finally(() => { inFlight = null; });
    }

    // Kick off this lane's first tick
    timer = setTimeout(() => { launchTick(); }, 0);

    return {
      async stop(): Promise<void> {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        // Drain any in-flight tick before returning — handler may be mid-write.
        if (inFlight) {
          try { await inFlight; } catch { /* already logged via onUncaught */ }
        }
      }
    };
  }

  const lanes: Lane[] = [];
  for (let laneId = 0; laneId < concurrency; laneId++) {
    lanes.push(createLane(laneId));
  }

  return {
    async stop(): Promise<void> {
      stopped = true;
      // Draining lanes in parallel is safe: every lane's stop() only clears
      // its own timer and awaits its own inFlight promise (job execution is
      // independent per lane; the shared claim is already race-safe — see
      // startWorker's doc comment).
      await Promise.all(lanes.map((lane) => lane.stop()));
    }
  };
}
