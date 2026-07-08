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

  constructor(message: string, public readonly cause?: unknown) {
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
