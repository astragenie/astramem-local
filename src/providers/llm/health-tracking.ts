import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider, LLMProviderName } from '../../contracts/llm.js';

/**
 * Types owned HERE (the providers layer), not in server/health-state.ts —
 * `src/server/health-state.ts`'s `status()` imports `hasAnyProviderDown()`
 * from this module (a one-directional server -> providers dependency,
 * already established by `src/server/routes/search.ts` importing
 * `buildLLMProvider` from `providers/index.ts`). Defining these types on the
 * server side and importing them back here would make that a genuine
 * circular VALUE import instead.
 */
export type ProviderHealthStatus = 'up' | 'down';

/** Only these three failure shapes count toward "provider is down" — see
 *  classifyProviderFailure's doc comment for what's deliberately excluded. */
export type ProviderFailureKind = 'auth' | 'quota' | 'server_error';

export interface ProviderHealthEntry {
  status: ProviderHealthStatus;
  /** Classification of the failure that (last) flipped this entry `down`;
   *  null while `status === 'up'`. */
  reason: ProviderFailureKind | null;
  /** Actionable, provider-aware remedy text (AC-4) — null while `up`. */
  message: string | null;
  /** epoch ms this entry last transitioned status; null until the first
   *  transition. */
  since: number | null;
  /** Consecutive auth/quota/server_error failures since the last success —
   *  resets to 0 on every success, regardless of status. */
  consecutiveFailures: number;
  lastError: string | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

export function createProviderHealthEntry(): ProviderHealthEntry {
  return {
    status: 'up',
    reason: null,
    message: null,
    since: null,
    consecutiveFailures: 0,
    lastError: null,
    lastFailureAt: null,
    lastSuccessAt: null,
  };
}

/**
 * Main-provider regression health tracking (FEAT-538).
 *
 * Motivating incident (2026-07-17, live prod): codex-subscription's refresh
 * token was consumed, so every distill call 401'd — 187 poison jobs — while
 * `GET /health` kept reporting `status: "ok"` because nothing fed provider
 * failures back into health state at all. The 15-min doctor tier couldn't
 * have caught this in time either way: a metered LLM chat-probe on a tight
 * interval against a real (and, for codex-subscription, ChatGPT-quota-
 * metered) provider is the FEAT-482 self-DoS class this repo already got
 * burned by once. So this reads the ERROR SIGNAL off real traffic instead of
 * polling: a decorator around `LLMProvider.chat()`.
 *
 * WIRING POINT: `buildLLMProvider()` (src/providers/index.ts) applies this
 * unconditionally to EVERY provider it constructs — mirroring exactly how
 * that same function already wraps every provider in `rateLimitLLMProvider`.
 * One wiring point therefore covers every role that flows through it
 * (compaction, extraction, the contradiction judge, extractionPassB,
 * atomTriage, and any one-off caller like search/decompose.ts), not just the
 * two roles the motivating incident happened to hit.
 *
 * KEYED BY PROVIDER NAME, not by role: a `ProviderHealthEntry` is shared by
 * every provider instance with the same `.name` (ollama / azure-openai /
 * openai-compatible / codex-subscription) — the same "one shared bucket per
 * provider name" pattern `rate-limited.ts`'s `sharedBuckets` already uses,
 * for the same reason: `extraction` and `compaction` (and `judge`, etc.) are
 * frequently backed by the SAME account, and role-keyed tracking would only
 * tell you "the extraction slot failed", not "codex-subscription is down" —
 * the actual, actionable fact when the user's fix is `codex login` or
 * switching providers. `/health` (src/server/routes/health.ts) resolves
 * "is my current extraction/compaction provider healthy" by looking up
 * `config.llm.{extraction,compaction}.provider` in this same registry.
 */

/** Only these three failure shapes count toward "provider is down" — the
 *  FEAT explicitly scopes to "auth 401/403, persistent errors [429, 5xx]".
 *  Deliberately EXCLUDED: JSON-parse/empty-text TransientErrors (a single
 *  stochastic bad LLM response is normal noise, not a provider outage — the
 *  worker's own MAX_ATTEMPTS retry/poison path already handles those), and
 *  DeterministicErrors that mean "misconfigured, not a live regression"
 *  (missing auth.json, bad JSON in auth.json, unset baseUrl) — those never
 *  reach this classifier because they throw at construction/first-load, not
 *  from a chat() call this decorator observes mid-flight the way a live 401
 *  regression does.
 *
 *  Every provider's chat() embeds the HTTP status in its thrown message as
 *  `HTTP <status>` (ollama.ts, azure-openai.ts, openai-compatible.ts) EXCEPT
 *  codex-subscription's special-cased 401-after-refresh-retry path, which
 *  instead says "still unauthorized after token refresh — re-login
 *  required" with no bare status code — hence the keyword fallbacks below
 *  alongside the `HTTP nnn` pattern match.
 */
export function classifyProviderFailure(err: unknown): { kind: ProviderFailureKind; message: string } | null {
  const message = err instanceof Error ? err.message : String(err);
  if (/\bHTTP\s+40[13]\b/.test(message) || /unauthoriz/i.test(message) || /re-login required/i.test(message)) {
    return { kind: 'auth', message };
  }
  if (/\bHTTP\s+429\b/.test(message) || /rate-limited\s*\(429\)/i.test(message) || /rate.?limit/i.test(message) || /\bquota\b/i.test(message)) {
    return { kind: 'quota', message };
  }
  if (/\bHTTP\s+5\d\d\b/.test(message)) {
    return { kind: 'server_error', message };
  }
  return null;
}

/** AC-4: actionable, provider-aware remedy text surfaced on `/health`.
 *  codex-subscription gets the specific `codex login` instruction (it's the
 *  provider the motivating incident hit); every other provider gets a
 *  generic credentials/quota nudge plus the same "or switch provider" exit
 *  this repo's BYO-providers work (#414) is building toward. */
export function providerFailureRemedy(providerName: string, kind: ProviderFailureKind): string {
  const switchHint = 'or switch provider (config.llm.extraction.provider / config.llm.compaction.provider)';
  if (kind === 'auth') {
    return providerName === 'codex-subscription'
      ? `${providerName}: auth failure — run \`codex login\` to refresh your ChatGPT session, ${switchHint}.`
      : `${providerName}: auth failure (401/403) — check your API key/credentials, ${switchHint}.`;
  }
  if (kind === 'quota') {
    return providerName === 'codex-subscription'
      ? `${providerName}: quota/rate limit (429) — check your ChatGPT subscription quota, wait and retry, ${switchHint}.`
      : `${providerName}: quota/rate limit (429) — check your plan limits, wait and retry, ${switchHint}.`;
  }
  return `${providerName}: repeated server errors (5xx) — the provider may be degraded; check its status page, ${switchHint}.`;
}

/** AC-5: require N CONSECUTIVE qualifying failures, not one blip, before
 *  flipping `down`. 3 mirrors the worker's own MAX_ATTEMPTS
 *  (src/pipeline/worker.ts) — by the time a job would poison from retries
 *  exhausted, the provider has also crossed this threshold, so `/health`
 *  goes degraded no later than the first poisoned job from this cause. */
export const DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

/**
 * LLMProvider decorator (mirrors RateLimitedLLMProvider's shape) that
 * observes chat() outcomes and mutates `entry` — the SAME
 * `ProviderHealthEntry` object exposed on `healthState.providerHealth.{role}`
 * — in place. `health()` passes straight through unwrapped: it must stay a
 * point-in-time probe, not something this decorator's traffic-derived streak
 * can influence.
 */
export class HealthTrackingLLMProvider implements LLMProvider {
  readonly name: LLMProvider['name'];
  readonly model: string;

  constructor(
    private readonly inner: LLMProvider,
    private readonly entry: ProviderHealthEntry,
    private readonly threshold: number = DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
    private readonly now: () => number = Date.now,
  ) {
    this.name = inner.name;
    this.model = inner.model;
  }

  async chat(messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
    try {
      const result = await this.inner.chat(messages, opts);
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure(err);
      throw err;
    }
  }

  health(): Promise<LLMHealth> {
    return this.inner.health();
  }

  private recordSuccess(): void {
    this.entry.consecutiveFailures = 0;
    this.entry.lastSuccessAt = this.now();
    if (this.entry.status === 'down') {
      this.entry.status = 'up';
      this.entry.reason = null;
      this.entry.message = null;
      this.entry.since = this.now();
    }
  }

  private recordFailure(err: unknown): void {
    const classification = classifyProviderFailure(err);
    if (!classification) return; // not an auth/quota/5xx shape — doesn't move the streak.

    this.entry.consecutiveFailures += 1;
    this.entry.lastFailureAt = this.now();
    this.entry.lastError = classification.message;

    const crossingThreshold = this.entry.consecutiveFailures >= this.threshold;
    if (crossingThreshold) {
      const wasUp = this.entry.status === 'up';
      this.entry.status = 'down';
      this.entry.reason = classification.kind;
      this.entry.message = providerFailureRemedy(this.name, classification.kind);
      if (wasUp) this.entry.since = this.now();
    }
  }
}

/** Low-level factory: wraps `inner` against an EXPLICIT entry — the
 *  building block both `trackProviderHealth` (registry-backed, real wiring)
 *  and unit tests (a fresh, isolated entry per case) use. */
export function trackLLMProviderHealth(
  inner: LLMProvider,
  entry: ProviderHealthEntry,
  threshold: number = DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
): LLMProvider {
  return new HealthTrackingLLMProvider(inner, entry, threshold);
}

// ─── Process-wide registry, keyed by provider name ─────────────────────────
//
// Mirrors rate-limited.ts's `sharedBuckets` Map exactly: module-level state,
// lazily created per provider name on first use, with a `__reset*ForTest`
// escape hatch. This is what lets `buildLLMProvider()` wrap every provider
// it builds with ZERO extra plumbing — no healthState parameter needs to
// reach providers/index.ts, and no daemon-boot file (src/cli/serve.ts) needs
// to change at all for the wiring to be live in production.

const registry = new Map<LLMProviderName, ProviderHealthEntry>();

/** Returns the shared entry for `name`, creating a fresh 'up' one on first
 *  lookup. Same object every subsequent call for the same name — callers
 *  (the /health route, `trackProviderHealth`) always see the live state. */
export function getProviderHealthEntry(name: LLMProviderName): ProviderHealthEntry {
  let entry = registry.get(name);
  if (!entry) {
    entry = createProviderHealthEntry();
    registry.set(name, entry);
  }
  return entry;
}

/** Registry-backed factory — the one `providers/index.ts`'s
 *  `buildLLMProvider()` calls for every provider it constructs. Resolves
 *  `inner.name`'s shared entry via `getProviderHealthEntry` so every
 *  instance of the same named provider (extraction, compaction, judge,
 *  extractionPassB, atomTriage, or a one-off caller) contributes to and
 *  observes ONE health signal per provider name. */
export function trackProviderHealth(
  inner: LLMProvider,
  threshold: number = DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
): LLMProvider {
  return trackLLMProviderHealth(inner, getProviderHealthEntry(inner.name), threshold);
}

/** Test-only: drop every tracked entry so test files that construct real
 *  providers via `getProviders()`/`buildLLMProvider()` don't leak status
 *  across cases. Mirrors `__resetRateLimitBucketsForTest()`. */
export function __resetProviderHealthRegistryForTest(): void {
  registry.clear();
}

/**
 * `src/server/health-state.ts`'s `status()` gate (AC-1): true when ANY
 * currently-tracked provider is `down`. Safe to scope this broadly rather
 * than to "only the configured extraction/compaction provider": the
 * registry is process-lifetime state rebuilt fresh at every daemon boot
 * (config is read once per process — see CLAUDE.md's "Config reload"
 * section) via `getProviders()`, so it only ever holds entries for
 * providers this boot actually constructed and used — never a stale entry
 * left over from a since-changed config.
 */
export function hasAnyProviderDown(): boolean {
  for (const entry of registry.values()) {
    if (entry.status === 'down') return true;
  }
  return false;
}
