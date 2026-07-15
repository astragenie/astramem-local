import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { childLogger } from '../../log/logger.js';

/**
 * Async token bucket. Refills at `ratePerMinute` tokens/min up to `capacity`
 * (the burst allowance); `acquire()` resolves as soon as a whole token is
 * available, consuming it. One shared instance can serialize many concurrent
 * callers — each awaits its own token, so the aggregate call rate never
 * exceeds the refill rate over time while still permitting a short burst up to
 * `capacity`.
 *
 * Deliberately time-based (not a fixed setInterval): tokens accrue from
 * wall-clock elapsed on each check, so an idle bucket "banks" up to `capacity`
 * and there is no timer to leak. `now()` is injectable for deterministic tests.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly ratePerMinute: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = now();
  }

  private refill(): void {
    const nowMs = this.now();
    const elapsedMin = (nowMs - this.lastRefillMs) / 60_000;
    if (elapsedMin <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMin * this.ratePerMinute);
    this.lastRefillMs = nowMs;
  }

  /** Returns the whole tokens currently available (after refill) — test seam. */
  availableTokens(): number {
    this.refill();
    return Math.floor(this.tokens);
  }

  /**
   * Block until a token is available, then consume it. Honors an optional
   * AbortSignal (the caller's own timeout budget, ChatOpts.signal) so a
   * cancelled request stops waiting instead of holding a slot. Waits in
   * bounded slices (<=250ms) so cancellation is responsive and a clock jump
   * can't strand a caller.
   */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.ceil((deficit / this.ratePerMinute) * 60_000);
      await this.sleep(Math.min(Math.max(waitMs, 5), 250), signal);
    }
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * LLMProvider decorator that throttles chat() through a shared TokenBucket.
 * name/model and health() pass straight through (health must never be
 * rate-limited — it's the liveness probe). Only chat() acquires a token.
 */
export class RateLimitedLLMProvider implements LLMProvider {
  readonly name: LLMProvider['name'];
  readonly model: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly bucket: TokenBucket,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    await this.bucket.acquire(opts?.signal);
    return this.inner.chat(messages, opts);
  }

  health(): Promise<LLMHealth> {
    return this.inner.health();
  }
}

// Shared buckets keyed by provider name so every LLMProvider instance for the
// same provider (e.g. the separate compaction + extraction codex-subscription
// providers) throttles against ONE global budget rather than one bucket each.
const sharedBuckets = new Map<string, TokenBucket>();

/**
 * Wrap `inner` in a rate limiter when `callsPerMinute > 0`; otherwise return it
 * unchanged (zero overhead, zero behavior change — the disabled-by-default
 * posture). The bucket is shared across calls with the same `inner.name`.
 *
 * Burst capacity is ~10 seconds' worth of the rate (min 1) so a short burst is
 * tolerated but sustained load converges to `callsPerMinute`.
 */
export function rateLimitLLMProvider(
  inner: LLMProvider,
  callsPerMinute: number | undefined,
): LLMProvider {
  if (!callsPerMinute || callsPerMinute <= 0) return inner;
  let bucket = sharedBuckets.get(inner.name);
  if (!bucket) {
    const capacity = Math.max(1, Math.ceil(callsPerMinute / 6));
    bucket = new TokenBucket(callsPerMinute, capacity);
    sharedBuckets.set(inner.name, bucket);
    childLogger({ provider: inner.name }).info({ callsPerMinute, burst: capacity }, 'llm rate limit active');
  }
  return new RateLimitedLLMProvider(inner, bucket);
}

/** Test-only: drop shared buckets so each test starts clean. */
export function __resetRateLimitBucketsForTest(): void {
  sharedBuckets.clear();
}
