/**
 * Typed pipeline errors for failure classification.
 *
 * Throw TransientError for recoverable conditions (network failures, rate limits,
 * server-side 5xx) where retrying has a meaningful chance of success.
 *
 * Throw DeterministicError for conditions that will not self-heal (bad schema,
 * parse failure, 4xx auth/validation) where retrying wastes LLM budget.
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
