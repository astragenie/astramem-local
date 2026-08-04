/**
 * tests/providers/quota-breaker.test.ts (P0-1)
 *
 * Covers the consecutive-429 circuit breaker decorator — see
 * src/providers/llm/quota-breaker.ts for the incident this closes
 * (2026-07-31: codex-subscription quota exhaustion -> 198 poisoned distill
 * jobs, ~875 memories lost until a manual replay days later, because
 * budget.daily_usd cannot meter a $0-usd-always provider).
 *
 * This file exercises QuotaBreakerLLMProvider/wrapWithQuotaBreaker in
 * isolation. The end-to-end "distill pauses instead of poisoning" behavior
 * (worker.ts recognizing ProviderQuotaBreakerOpenError) is covered in
 * tests/pipeline/worker.test.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  QuotaBreakerLLMProvider,
  ProviderQuotaBreakerOpenError,
  wrapWithQuotaBreaker,
  resetAllProviderQuotaBreakers,
  __resetQuotaBreakersForTest,
  DEFAULT_QUOTA_BREAKER_THRESHOLD,
} from '../../src/providers/llm/quota-breaker.js';
import { TransientError, DeterministicError } from '../../src/pipeline/errors.js';
import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../src/contracts/llm.js';

class FakeProvider implements LLMProvider {
  readonly name: LLMProvider['name'];
  readonly model: string;
  private queue: Array<() => Promise<ChatResult>> = [];
  chats = 0;

  constructor(name: LLMProvider['name'] = 'codex-subscription', model = 'test') {
    this.name = name;
    this.model = model;
  }

  push(fn: () => Promise<ChatResult>): void {
    this.queue.push(fn);
  }

  async chat(_m: ChatMsg[], _o?: ChatOpts): Promise<ChatResult> {
    this.chats++;
    const next = this.queue.shift();
    if (!next) return { text: 'ok', usage: { in: 0, out: 0, usd: 0 } };
    return next();
  }

  async health(): Promise<LLMHealth> {
    return { ok: true, model: this.model, latency_ms: 1 };
  }
}

/** Mirrors the real HTTP 429 shape codex-subscription.ts throws (see that
 *  file's chat() — `HTTP ${res.status} — ${snippet}` where the live-observed
 *  snippet is `{"type":"usage_limit_reached","plan_type":"plus"}`). */
function fail429(): Promise<ChatResult> {
  return Promise.reject(
    new TransientError('codex-subscription chat failed: HTTP 429 — {"type":"usage_limit_reached","plan_type":"plus"}'),
  );
}

function fail401(): Promise<ChatResult> {
  return Promise.reject(
    new DeterministicError('codex-subscription: still unauthorized after token refresh — re-login required.'),
  );
}

function ok(): Promise<ChatResult> {
  return Promise.resolve({ text: 'ok', usage: { in: 1, out: 1, usd: 0 } });
}

describe('QuotaBreakerLLMProvider', () => {
  beforeEach(() => {
    __resetQuotaBreakersForTest();
  });

  it('passes through success calls untouched below threshold', async () => {
    const inner = new FakeProvider();
    const breaker = new QuotaBreakerLLMProvider(inner, 3);
    const result = await breaker.chat([{ role: 'user', content: 'hi' }]);
    expect(result.text).toBe('ok');
    expect(inner.chats).toBe(1);
  });

  it('rethrows the ORIGINAL error for each quota failure below the threshold — normal retry/backoff unchanged', async () => {
    const inner = new FakeProvider();
    inner.push(fail429);
    inner.push(fail429);
    const breaker = new QuotaBreakerLLMProvider(inner, 3);

    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    expect(inner.chats).toBe(2); // both calls actually reached the network
  });

  it('trips on the Nth consecutive quota failure and converts THAT call into ProviderQuotaBreakerOpenError', async () => {
    const inner = new FakeProvider();
    inner.push(fail429);
    inner.push(fail429);
    inner.push(fail429);
    const breaker = new QuotaBreakerLLMProvider(inner, 3);

    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    // 3rd consecutive quota failure: NOT the original TransientError — the
    // breaker-open sentinel, so THIS attempt is also paused, not failed.
    await expect(breaker.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);
    expect(inner.chats).toBe(3);
  });

  it('once tripped, short-circuits every further call with ZERO additional network calls', async () => {
    const inner = new FakeProvider();
    inner.push(fail429);
    inner.push(fail429);
    inner.push(fail429);
    const breaker = new QuotaBreakerLLMProvider(inner, 3);

    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);
    expect(inner.chats).toBe(3);

    // Two more calls after tripping — inner must NOT be invoked again.
    await expect(breaker.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);
    expect(inner.chats).toBe(3); // unchanged — no further network burn
  });

  it('resets the counter on ANY success — a good call in between does not accumulate toward the trip', async () => {
    const inner = new FakeProvider();
    inner.push(fail429);
    inner.push(fail429);
    inner.push(ok); // resets
    inner.push(fail429);
    inner.push(fail429);
    const breaker = new QuotaBreakerLLMProvider(inner, 3);

    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    const success = await breaker.chat([]);
    expect(success.text).toBe('ok');
    // Two more quota failures — still below threshold because the success reset the streak.
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    expect(inner.chats).toBe(5);
  });

  it('does NOT count a non-quota (e.g. 401) failure toward the quota-specific threshold', async () => {
    const inner = new FakeProvider();
    inner.push(fail401);
    inner.push(fail429);
    inner.push(fail429);
    const breaker = new QuotaBreakerLLMProvider(inner, 3);

    await expect(breaker.chat([])).rejects.toBeInstanceOf(DeterministicError);
    // Only 2 quota failures so far (401 didn't count) — still below threshold 3.
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    expect(inner.chats).toBe(3);
  });

  it('is keyed per provider NAME — tripping one name does not affect another', async () => {
    const codex = new FakeProvider('codex-subscription');
    codex.push(fail429);
    codex.push(fail429);
    codex.push(fail429);
    const ollama = new FakeProvider('ollama');

    const codexBreaker = new QuotaBreakerLLMProvider(codex, 3);
    const ollamaBreaker = new QuotaBreakerLLMProvider(ollama, 3);

    await expect(codexBreaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(codexBreaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(codexBreaker.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);

    const result = await ollamaBreaker.chat([]);
    expect(result.text).toBe('ok');
  });

  it('wrapWithQuotaBreaker returns inner unchanged when mode is off', async () => {
    const inner = new FakeProvider();
    inner.push(fail429);
    inner.push(fail429);
    inner.push(fail429);
    const wrapped = wrapWithQuotaBreaker(inner, { mode: 'off' });
    expect(wrapped).toBe(inner);
    await expect(wrapped.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(wrapped.chat([])).rejects.toBeInstanceOf(TransientError);
    // No breaker at all -> still the original error on the 3rd call too.
    await expect(wrapped.chat([])).rejects.toBeInstanceOf(TransientError);
  });

  it('wrapWithQuotaBreaker treats absent config as enabled at the default threshold', async () => {
    const inner = new FakeProvider();
    for (let i = 0; i < DEFAULT_QUOTA_BREAKER_THRESHOLD; i++) inner.push(fail429);
    const wrapped = wrapWithQuotaBreaker(inner, undefined);
    for (let i = 0; i < DEFAULT_QUOTA_BREAKER_THRESHOLD - 1; i++) {
      await expect(wrapped.chat([])).rejects.toBeInstanceOf(TransientError);
    }
    await expect(wrapped.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);
  });

  it('wrapWithQuotaBreaker falls back to the default threshold on a malformed config value', async () => {
    const inner = new FakeProvider();
    inner.push(fail429);
    const wrapped = wrapWithQuotaBreaker(inner, { consecutiveFailureThreshold: -1 });
    // -1 is malformed -> breaker disabled entirely -> inner unchanged.
    expect(wrapped).toBe(inner);
    await expect(wrapped.chat([])).rejects.toBeInstanceOf(TransientError);
  });

  it('resetAllProviderQuotaBreakers clears a tripped breaker and reports how many were tripped', async () => {
    const inner = new FakeProvider();
    inner.push(fail429);
    inner.push(fail429);
    inner.push(fail429);
    inner.push(ok);
    const breaker = new QuotaBreakerLLMProvider(inner, 3);

    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);

    // Tripped — even a queued success is never reached without a reset.
    const trippedCount = resetAllProviderQuotaBreakers();
    expect(trippedCount).toBe(1);

    const result = await breaker.chat([]);
    expect(result.text).toBe('ok');
    expect(inner.chats).toBe(4);
  });

  it('resetAllProviderQuotaBreakers reports 0 when nothing was tripped', () => {
    expect(resetAllProviderQuotaBreakers()).toBe(0);
  });

  it('name/model pass through from inner, health() is never gated by the breaker', async () => {
    const inner = new FakeProvider('codex-subscription', 'gpt-5.4-mini');
    inner.push(fail429);
    inner.push(fail429);
    inner.push(fail429);
    const breaker = new QuotaBreakerLLMProvider(inner, 3);
    expect(breaker.name).toBe('codex-subscription');
    expect(breaker.model).toBe('gpt-5.4-mini');

    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(TransientError);
    await expect(breaker.chat([])).rejects.toBeInstanceOf(ProviderQuotaBreakerOpenError);

    // health() is a pass-through probe, unaffected by the tripped breaker.
    const health = await breaker.health();
    expect(health.ok).toBe(true);
  });
});
