import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../contracts/llm.js';
import { childLogger } from '../../log/logger.js';
import { classifyProviderFailure, DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD } from './health-tracking.js';

/**
 * P0-1: consecutive-429 circuit breaker for the LLM provider layer.
 *
 * Motivating incident (2026-07-31, live prod): `budget.daily_usd` is
 * structurally blind to codex-subscription (and ollama — see both
 * providers' `usage.usd: 0`, and `src/doctor/checks/budget-cap-codex-blind.ts`),
 * so a ChatGPT quota exhaustion (`HTTP 429 {"type":"usage_limit_reached",...}`)
 * on every call was invisible to the dollar cap. The worker's normal
 * transient-retry path (src/pipeline/worker.ts) then retried the SAME
 * quota-exhausted call up to MAX_ATTEMPTS times before poisoning the job —
 * poisoning 198 distill jobs and losing ~875 memories until a manual replay
 * three days later.
 *
 * A dollar cap cannot fix this by construction (FEAT-482, do not re-propose
 * estimating a $ cost for subscription-quota traffic — see CLAUDE.md). This
 * is a PROVIDER-ERROR-SIGNAL breaker instead: it watches consecutive
 * quota/429 failures on `LLMProvider.chat()` (reusing `classifyProviderFailure`
 * from health-tracking.ts — FEAT-538 already built exactly this HTTP-429/
 * `usage_limit_reached`-shaped classifier, no need for a second one) and,
 * once tripped, throws `ProviderQuotaBreakerOpenError` instead of letting the
 * call reach the network. `src/pipeline/worker.ts` recognizes that sentinel
 * the same way it already recognizes `DistillBudgetPausedError` — PAUSE the
 * job (JobRepo.pause), not fail() — so a quota storm burns zero further
 * attempts toward poison, for ANY job kind that flows an LLM call through a
 * provider built via `buildLLMProvider` (src/providers/index.ts), not just
 * distill (mirrors `JobRepo.requeuePaused()`'s deliberately job-kind-agnostic
 * design).
 *
 * WIRING POINT: `buildLLMProvider()` wraps every provider it constructs —
 * same single-wiring-point pattern `rateLimitLLMProvider`/`trackProviderHealth`
 * already use, so every role (compaction, extraction, judge, extractionPassB,
 * atomTriage, dupJudge, gatekeeper) is covered with zero extra plumbing.
 *
 * KEYED BY PROVIDER NAME, not by role — same rationale as health-tracking.ts:
 * a ChatGPT subscription quota is account-level, not per-role, so a trip on
 * `extraction` must also stop `compaction` calls against the same account.
 *
 * OUT OF SCOPE (flagged, not fixed here): this repo has FIVE hand-copied
 * `{mode, maxPerRun, maxWallClockMs}` config blocks (contradictionDetection,
 * dupJudge, extractionPassB, atomTriage, gatekeeper) that a shared governor
 * could unify — tracked separately as P1-3. This breaker deliberately does
 * NOT join that refactor; it mirrors only the `mode` field naming convention
 * for consistency, not the full shape (a consecutive-failure breaker has no
 * `maxPerRun`/`maxWallClockMs` equivalent).
 *
 * RECOVERY: once tripped, this breaker short-circuits every subsequent call
 * for that provider name WITHOUT calling the network — so a success can never
 * occur on its own to satisfy "reset on success". Recovery is therefore
 * manual, mirroring the EXISTING `BudgetExceeded`/`DistillBudgetPausedError`
 * pattern exactly (`astramem-local budget --reset` already requeues paused
 * jobs — see JobRepo.requeuePaused's doc comment for why that's job-kind-
 * agnostic): `resetAllProviderQuotaBreakers()` is wired into the same
 * `--reset` flag (src/cli/budget.ts) so ONE operator action clears both the
 * dollar cap and the quota breaker. A time-based half-open auto-retry would
 * be a reasonable follow-up but is intentionally not built here — YAGNI
 * until an operator actually wants unattended recovery over a manual nudge
 * once the underlying quota/plan issue is confirmed resolved.
 */

/**
 * Sentinel error thrown when the quota circuit breaker is OPEN for a
 * provider. `src/pipeline/worker.ts` special-cases this (mirroring
 * `DistillBudgetPausedError.is(err)`) to pause the job instead of failing
 * it, so a quota storm does not consume the job's attempt budget.
 */
export class ProviderQuotaBreakerOpenError extends Error {
  constructor(
    public readonly providerName: string,
    public readonly consecutiveFailures: number,
  ) {
    super(
      `${providerName}: quota circuit breaker OPEN after ${consecutiveFailures} consecutive quota/429 ` +
        'failures — pausing rather than retrying toward poison. Run `astramem-local budget --reset` once ' +
        'the underlying quota/plan issue is resolved (also requeues any job this paused).',
    );
    this.name = 'ProviderQuotaBreakerOpenError';
  }

  static is(err: unknown): err is ProviderQuotaBreakerOpenError {
    return err instanceof ProviderQuotaBreakerOpenError;
  }
}

/** `config.llm.quotaBreaker` shape — see Config type doc comment. */
export interface QuotaBreakerConfig {
  mode?: 'off' | 'enabled';
  consecutiveFailureThreshold?: number;
}

/** Default trip threshold: 3 mirrors `DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD`
 *  (health-tracking.ts), which itself mirrors the worker's own MAX_ATTEMPTS
 *  (src/pipeline/worker.ts) — by the time a job would poison from retries
 *  exhausted, the breaker has also crossed this threshold, so the pause
 *  fires no later than the point poisoning would have. Reusing the SAME
 *  constant (not a second independent magic number) keeps "3 consecutive
 *  failures" meaning one consistent thing across /health degradation and
 *  job pausing. */
export const DEFAULT_QUOTA_BREAKER_THRESHOLD = DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD;

interface BreakerState {
  consecutiveQuotaFailures: number;
  tripped: boolean;
}

// Mirrors rate-limited.ts's `sharedBuckets` / health-tracking.ts's `registry`
// module-level Map pattern: lazily created per provider name, process-lifetime
// state, with a `__reset*ForTest` escape hatch.
const registry = new Map<string, BreakerState>();

function getState(name: string): BreakerState {
  let state = registry.get(name);
  if (!state) {
    state = { consecutiveQuotaFailures: 0, tripped: false };
    registry.set(name, state);
  }
  return state;
}

/**
 * LLMProvider decorator (mirrors RateLimitedLLMProvider/HealthTrackingLLMProvider's
 * shape). Before delegating to `inner.chat()`, checks whether this provider's
 * breaker is already tripped — if so, throws `ProviderQuotaBreakerOpenError`
 * immediately with NO network call (protects the already-exhausted quota from
 * further burn). Otherwise delegates, classifies any failure via
 * `classifyProviderFailure`, and:
 *   - non-quota failure (or success): passes through unchanged, does not
 *     move the quota-specific counter (requirement: detect the quota signal
 *     SPECIFICALLY, not generic errors).
 *   - quota failure below threshold: increments the counter, rethrows the
 *     ORIGINAL error — normal transient retry/backoff still applies for the
 *     first `threshold - 1` failures, unchanged from today.
 *   - quota failure AT threshold: this is the call that trips the breaker.
 *     Thrown as `ProviderQuotaBreakerOpenError` (not the original error) so
 *     THIS attempt also gets paused rather than failed — the trip must not
 *     wait for a subsequent call to take effect, or a threshold equal to
 *     MAX_ATTEMPTS would poison on the exact call that should have paused.
 */
export class QuotaBreakerLLMProvider implements LLMProvider {
  readonly name: LLMProvider['name'];
  readonly model: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly threshold: number = DEFAULT_QUOTA_BREAKER_THRESHOLD,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    const state = getState(this.name);

    if (state.tripped) {
      throw new ProviderQuotaBreakerOpenError(this.name, state.consecutiveQuotaFailures);
    }

    try {
      const result = await this.inner.chat(messages, opts);
      // Requirement: reset the counter on ANY success.
      state.consecutiveQuotaFailures = 0;
      return result;
    } catch (err) {
      const classification = classifyProviderFailure(err);
      if (classification?.kind !== 'quota') {
        // Not a quota/429 signal — do not move the quota-specific counter.
        throw err;
      }

      state.consecutiveQuotaFailures += 1;
      if (state.consecutiveQuotaFailures >= this.threshold) {
        state.tripped = true;
        childLogger({ provider: this.name }).warn(
          { consecutiveFailures: state.consecutiveQuotaFailures, threshold: this.threshold },
          'quota circuit breaker TRIPPED — pausing rather than retrying toward poison',
        );
        throw new ProviderQuotaBreakerOpenError(this.name, state.consecutiveQuotaFailures);
      }
      throw err;
    }
  }

  health(): Promise<LLMHealth> {
    return this.inner.health();
  }
}

/**
 * Wrap `inner` in the quota breaker unless explicitly disabled
 * (`mode: 'off'`) or the configured threshold is malformed
 * (non-finite/non-positive) — a bad/hand-edited config value degrades to
 * "breaker disabled" rather than blocking daemon boot, same posture as
 * `resolveWorkerConcurrency` (worker.ts). Absent config (`undefined`) is
 * treated as enabled at the default threshold — deliberately fail-safe
 * TOWARD protection, since `defaultConfig()` always sets `mode: 'enabled'`
 * and only a hand-built test/partial Config would omit this key at all.
 */
export function wrapWithQuotaBreaker(inner: LLMProvider, cfg?: QuotaBreakerConfig): LLMProvider {
  if (cfg?.mode === 'off') return inner;
  const threshold = cfg?.consecutiveFailureThreshold ?? DEFAULT_QUOTA_BREAKER_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold <= 0) return inner;
  return new QuotaBreakerLLMProvider(inner, threshold);
}

/**
 * Manual recovery (see file doc comment "RECOVERY"): clears every tripped/
 * accumulated breaker state. Returns the number of provider names that were
 * actually tripped (0 if none were) so callers (budgetCommand --reset) can
 * report something meaningful instead of an unconditional "reset" message.
 */
export function resetAllProviderQuotaBreakers(): number {
  let trippedCount = 0;
  for (const state of registry.values()) {
    if (state.tripped) trippedCount += 1;
    state.consecutiveQuotaFailures = 0;
    state.tripped = false;
  }
  return trippedCount;
}

/** Test-only: drop every tracked breaker state so test files don't leak
 *  tripped/consecutive-failure state across cases. Mirrors
 *  `__resetRateLimitBucketsForTest()` / `__resetProviderHealthRegistryForTest()`. */
export function __resetQuotaBreakersForTest(): void {
  registry.clear();
}
