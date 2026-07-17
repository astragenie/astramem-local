/**
 * tests/providers/health-tracking.test.ts (FEAT-538)
 *
 * Covers the chat()-observing decorator that feeds real provider failures
 * into a ProviderHealthEntry — see src/providers/llm/health-tracking.ts for
 * the incident this closes (2026-07-17: codex 401 -> 187 poison jobs while
 * /health kept saying "ok"). This file exercises the low-level, explicit-
 * entry decorator (`trackLLMProviderHealth`) in isolation; the
 * registry-backed wiring (`trackProviderHealth`, consumed by
 * `providers/index.ts`'s `buildLLMProvider`) is covered end-to-end in
 * tests/server/provider-health-degraded.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyProviderFailure,
  providerFailureRemedy,
  trackLLMProviderHealth,
  HealthTrackingLLMProvider,
  DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD,
  createProviderHealthEntry,
} from '../../src/providers/llm/health-tracking.js';
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

  /** Queue one canned outcome per call — FIFO. */
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

function fail401(): Promise<ChatResult> {
  return Promise.reject(
    new DeterministicError('codex-subscription: still unauthorized after token refresh — re-login required. '),
  );
}

function fail429(): Promise<ChatResult> {
  return Promise.reject(new TransientError('codex-subscription chat failed: HTTP 429 — rate-limited'));
}

function fail500(): Promise<ChatResult> {
  return Promise.reject(new TransientError('Ollama chat failed: HTTP 503 — upstream unavailable'));
}

function ok(): Promise<ChatResult> {
  return Promise.resolve({ text: 'ok', usage: { in: 1, out: 1, usd: 0 } });
}

describe('classifyProviderFailure', () => {
  it('classifies codex-subscription 401-after-refresh as auth (no bare "HTTP 401" in the message)', () => {
    const c = classifyProviderFailure(new Error('codex-subscription: still unauthorized after token refresh — re-login required.'));
    expect(c?.kind).toBe('auth');
  });

  it('classifies a generic "HTTP 401"/"HTTP 403" message as auth', () => {
    expect(classifyProviderFailure(new Error('Azure OpenAI chat failed: HTTP 401 — nope'))?.kind).toBe('auth');
    expect(classifyProviderFailure(new Error('openai-compatible chat failed: HTTP 403 — nope'))?.kind).toBe('auth');
  });

  it('classifies HTTP 429 / rate-limit / quota wording as quota', () => {
    expect(classifyProviderFailure(new Error('codex-subscription chat failed: HTTP 429 — slow down'))?.kind).toBe('quota');
    expect(classifyProviderFailure(new Error('Ollama chat rate-limited (429): retry later'))?.kind).toBe('quota');
    expect(classifyProviderFailure(new Error('daily quota exceeded'))?.kind).toBe('quota');
  });

  it('classifies HTTP 5xx as server_error', () => {
    expect(classifyProviderFailure(new Error('Ollama chat failed: HTTP 503 — down'))?.kind).toBe('server_error');
    expect(classifyProviderFailure(new Error('Azure OpenAI chat failed: HTTP 500 — down'))?.kind).toBe('server_error');
  });

  it('returns null for failures that are not auth/quota/5xx (e.g. empty-JSON parse blips)', () => {
    expect(classifyProviderFailure(new TransientError('codex-subscription returned empty text for a json-mode request'))).toBeNull();
    expect(classifyProviderFailure(new Error('unexpected token in JSON'))).toBeNull();
  });
});

describe('providerFailureRemedy (AC-4)', () => {
  it('names codex login for codex-subscription auth failures', () => {
    const msg = providerFailureRemedy('codex-subscription', 'auth');
    expect(msg).toContain('codex-subscription');
    expect(msg).toMatch(/codex login/);
  });

  it('distinguishes quota (429) wording from auth (401) wording', () => {
    const authMsg = providerFailureRemedy('codex-subscription', 'auth');
    const quotaMsg = providerFailureRemedy('codex-subscription', 'quota');
    expect(authMsg).not.toEqual(quotaMsg);
    expect(quotaMsg).toMatch(/quota|rate limit/i);
    expect(authMsg).toMatch(/auth|login/i);
  });

  it('gives a generic credentials nudge (not codex login) for a non-codex provider', () => {
    const msg = providerFailureRemedy('ollama', 'auth');
    expect(msg).not.toMatch(/codex login/);
    expect(msg).toMatch(/credentials|api key/i);
  });

  it('every remedy mentions switching provider', () => {
    for (const kind of ['auth', 'quota', 'server_error'] as const) {
      expect(providerFailureRemedy('codex-subscription', kind)).toMatch(/switch provider/i);
    }
  });
});

describe('HealthTrackingLLMProvider (AC-1, AC-5)', () => {
  it('flips down only after N consecutive qualifying failures, not one blip', async () => {
    const inner = new FakeProvider();
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry, 3);

    inner.push(fail401);
    await expect(wrapped.chat([])).rejects.toThrow();
    expect(entry.status).toBe('up'); // 1 of 3 — not yet down
    expect(entry.consecutiveFailures).toBe(1);

    inner.push(fail401);
    await expect(wrapped.chat([])).rejects.toThrow();
    expect(entry.status).toBe('up'); // 2 of 3

    inner.push(fail401);
    await expect(wrapped.chat([])).rejects.toThrow();
    expect(entry.status).toBe('down'); // 3 of 3 — AC-1
    expect(entry.reason).toBe('auth');
    expect(entry.since).not.toBeNull();
  });

  it('a single transient blip never flips status down (AC-5)', async () => {
    const inner = new FakeProvider();
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry, DEFAULT_CONSECUTIVE_FAILURE_THRESHOLD);

    inner.push(fail500);
    await expect(wrapped.chat([])).rejects.toThrow();
    expect(entry.status).toBe('up');
    expect(entry.consecutiveFailures).toBe(1);
  });

  it('a healthy provider keeps reporting up — no false-degraded (AC-5)', async () => {
    const inner = new FakeProvider();
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry);

    inner.push(ok); await wrapped.chat([]);
    inner.push(ok); await wrapped.chat([]);
    inner.push(ok); await wrapped.chat([]);
    expect(entry.status).toBe('up');
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.lastSuccessAt).not.toBeNull();
  });

  it('a 429 quota failure sequence produces a quota-flavored down entry', async () => {
    const inner = new FakeProvider();
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry, 2);

    inner.push(fail429);
    await expect(wrapped.chat([])).rejects.toThrow();
    inner.push(fail429);
    await expect(wrapped.chat([])).rejects.toThrow();

    expect(entry.status).toBe('down');
    expect(entry.reason).toBe('quota');
    expect(entry.message).toMatch(/quota|rate limit/i);
  });

  it('recovers to up on the very next success after being down', async () => {
    const inner = new FakeProvider();
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry, 2);

    inner.push(fail401); await expect(wrapped.chat([])).rejects.toThrow();
    inner.push(fail401); await expect(wrapped.chat([])).rejects.toThrow();
    expect(entry.status).toBe('down');

    inner.push(ok);
    await wrapped.chat([]);
    expect(entry.status).toBe('up');
    expect(entry.reason).toBeNull();
    expect(entry.message).toBeNull();
    expect(entry.consecutiveFailures).toBe(0);
  });

  it('a non-qualifying failure (empty-JSON blip) does not move the streak at all', async () => {
    const inner = new FakeProvider();
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry, 2);

    inner.push(() => Promise.reject(new TransientError('codex-subscription returned empty text for a json-mode request')));
    await expect(wrapped.chat([])).rejects.toThrow();
    expect(entry.consecutiveFailures).toBe(0);
    expect(entry.status).toBe('up');
  });

  it('preserves name/model and passes health() straight through unwrapped', async () => {
    const inner = new FakeProvider('ollama', 'qwen2.5:7b');
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry);
    expect(wrapped).toBeInstanceOf(HealthTrackingLLMProvider);
    expect(wrapped.name).toBe('ollama');
    expect(wrapped.model).toBe('qwen2.5:7b');
    const h = await wrapped.health();
    expect(h.ok).toBe(true);
  });
});
