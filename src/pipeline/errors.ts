/**
 * Typed pipeline errors for failure classification.
 *
 * Throw TransientError for recoverable conditions (network failures, rate limits,
 * server-side 5xx) where retrying has a meaningful chance of success. This also
 * covers LLM JSON-output parse/validation failures (see 05-extract.ts) — LLM
 * output is stochastic, so one malformed response is not proof the next call
 * will fail too; those get retried up to the normal attempt cap before the
 * job is poisoned.
 *
 * Throw DeterministicError for conditions that will not self-heal (malformed
 * request/job payload, missing required input, unsupported job kind, 4xx auth)
 * where retrying wastes LLM budget.
 */

export class TransientError extends Error {
  readonly kind = 'transient' as const;

  constructor(
    message: string,
    public readonly cause?: unknown,
    /** Milliseconds to wait before retrying, when the failure carried a
     *  server-supplied `Retry-After` hint (HTTP 429/503) — see
     *  src/providers/llm/retry-after.ts for the header parser LLM providers
     *  use to populate this. `undefined` (the default, and every call site
     *  that predates this field) means no such hint was available;
     *  worker.ts falls back to its own exponential backoff in that case. */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TransientError';
  }

  static is(err: unknown): err is TransientError {
    return err instanceof Error && (err as { kind?: unknown }).kind === 'transient';
  }
}

export class DeterministicError extends Error {
  readonly kind = 'deterministic' as const;

  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'DeterministicError';
  }

  static is(err: unknown): err is DeterministicError {
    return err instanceof Error && (err as { kind?: unknown }).kind === 'deterministic';
  }
}

/**
 * Sentinel error a job handler throws when a `BudgetTracker` cap (see
 * src/budget/tracker.ts) blocks a mid-job LLM call. The worker (worker.ts)
 * checks for this AHEAD of the transient/deterministic classification above
 * and moves the job to 'paused' instead of 'failed' — attempts are NOT
 * incremented, so repeated daily-cap hits never poison the job, and it sits
 * paused until the operator runs `astramem-local budget --reset` (which
 * both zeroes today's spend AND requeues paused jobs — see
 * `JobRepo.requeuePaused` / src/cli/budget.ts).
 *
 * Originally distill-only (named `DistillBudgetPausedError`); FEAT-482
 * generalized it when the consolidate contradiction judge (src/consolidate/
 * contradiction-judge.ts) was wired through the same BudgetTracker. Any job
 * handler that calls `BudgetTracker.assertCanSpend` mid-handle should catch
 * the resulting `BudgetExceeded` and rethrow this, the same way
 * pipeline/handlers/distill.ts and pipeline/handlers/consolidate.ts do.
 */
export class BudgetPausedError extends Error {
  constructor(budgetMessage: string) {
    super(`BUDGET_PAUSED:${budgetMessage}`);
    this.name = 'BudgetPausedError';
  }

  static is(err: unknown): err is BudgetPausedError {
    return err instanceof BudgetPausedError;
  }
}
