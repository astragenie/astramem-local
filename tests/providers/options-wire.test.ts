/**
 * FEAT-483 SLICE-4 — cross-provider options wire-assert e2e.
 *
 * Canary for two real, previously-shipped LLM-provider bugs (see
 * src/providers/llm/ollama.ts's module doc comment + CLAUDE.md's "LLM
 * sampling: num_ctx and temperature" section):
 *
 *  1. `temperature` silently dropped whenever `maxTokens` was ALSO set — a
 *     second top-level `{ options: {...} }` spread (once for temperature,
 *     once for num_predict) replaced the first object instead of merging
 *     into it. Silent: no error, just thinner sampling control on every real
 *     extraction/compaction/entity call in production.
 *  2. `num_ctx` never sent at all, so every Ollama call ran at the model's
 *     truncating per-model default (observed 4096) — Ollama does not error
 *     on overflow, it silently truncates/shifts context, which is
 *     indistinguishable from "the model just produced less."
 *
 * Both bugs shared the same signature: nothing ever threw, tests stayed
 * green, and the only observable was thinner output. The existing
 * per-provider `ollama-llm.test.ts` "num_ctx sizing" describe block already
 * pins the fix for Ollama specifically. This file generalizes the same
 * assertion — "the exact sampling values the caller passed actually reach
 * the wire, in the provider's own field names, together, without one
 * clobbering the other" — across EVERY registered LLM provider adapter
 * (tests/providers/_llm-provider-adapters.ts), so a future provider (or a
 * refactor of an existing one) can't reintroduce the same silent-drop shape
 * anywhere in the fleet.
 *
 * Every assertion runs against the REAL outgoing request body each provider
 * emits, via a real fetch mock (never a shape the test author assumes) — see
 * llm-contract-conformance.test.ts's file doc comment for why that
 * discipline matters here specifically.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ALL_LLM_ADAPTERS } from './_llm-provider-adapters.js';
import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../src/contracts/llm.js';
import { TokenBucket, RateLimitedLLMProvider } from '../../src/providers/llm/rate-limited.js';
import { trackLLMProviderHealth, createProviderHealthEntry } from '../../src/providers/llm/health-tracking.js';

describe.each(ALL_LLM_ADAPTERS)('cross-provider options wire-assert — $name', (adapter) => {
  let restoreFetch: () => void;
  const sp = adapter.samplingParams;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreFetch = () => {
      globalThis.fetch = original;
    };
  });

  afterEach(() => {
    restoreFetch();
  });

  // ── 1. THE double-spread regression guard ──────────────────────────────
  // temperature AND maxTokens set together in the SAME call — the exact
  // shape that triggers the double-spread bug class (a second options/body
  // merge clobbering the first) if it were ever reintroduced anywhere.
  it('sends temperature and the maxTokens-equivalent field TOGETHER without one clobbering the other', async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = adapter.createProvider((req) => {
      captured = req.body;
      return adapter.successResponse('ok');
    });

    await provider.chat([{ role: 'user', content: 'x' }], { temperature: 0.37, maxTokens: 777 });

    expect(captured).toBeDefined();
    if (sp.supportsTemperature) {
      expect(sp.temperature(captured!)).toBe(0.37);
    } else {
      expect(sp.temperature(captured!)).toBeUndefined();
    }
    if (sp.supportsMaxTokens) {
      expect(sp.maxTokensEquivalent(captured!)).toBe(777);
    } else {
      expect(sp.maxTokensEquivalent(captured!)).toBeUndefined();
    }

    // Ollama-only: num_ctx must also reach the wire, dynamically sized
    // within its documented floor/cap — the second half of the FEAT-479 fix.
    if (adapter.numCtx) {
      const numCtx = adapter.numCtx.read(captured!);
      expect(numCtx).toBeDefined();
      expect(numCtx!).toBeGreaterThanOrEqual(adapter.numCtx.floor);
      expect(numCtx!).toBeLessThanOrEqual(adapter.numCtx.cap);
    }
  });

  // ── 2. temperature alone ────────────────────────────────────────────────
  it('sends temperature alone when only temperature is set', async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = adapter.createProvider((req) => {
      captured = req.body;
      return adapter.successResponse('ok');
    });

    await provider.chat([{ role: 'user', content: 'x' }], { temperature: 0.55 });

    expect(captured).toBeDefined();
    if (sp.supportsTemperature) {
      expect(sp.temperature(captured!)).toBe(0.55);
    } else {
      expect(sp.temperature(captured!)).toBeUndefined();
    }
    // maxTokens opt was never passed — the equivalent field must reflect
    // this provider's own "no maxTokens given" policy: absent, unless the
    // provider always sends a fixed default (Anthropic).
    if (sp.maxTokensAlwaysSent) {
      expect(sp.maxTokensEquivalent(captured!)).toBe(sp.defaultMaxTokens);
    } else {
      expect(sp.maxTokensEquivalent(captured!)).toBeUndefined();
    }
  });

  // ── 3. maxTokens alone ───────────────────────────────────────────────────
  it('sends the maxTokens-equivalent field alone when only maxTokens is set', async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = adapter.createProvider((req) => {
      captured = req.body;
      return adapter.successResponse('ok');
    });

    await provider.chat([{ role: 'user', content: 'x' }], { maxTokens: 999 });

    expect(captured).toBeDefined();
    // temperature opt was never passed — must be absent regardless of
    // whether the provider supports the knob at all.
    expect(sp.temperature(captured!)).toBeUndefined();
    if (sp.supportsMaxTokens) {
      expect(sp.maxTokensEquivalent(captured!)).toBe(999);
    } else {
      expect(sp.maxTokensEquivalent(captured!)).toBeUndefined();
    }
  });

  // ── 4. neither set — negative space ─────────────────────────────────────
  it('omits both fields when neither is set, except a provider that always sends a default', async () => {
    let captured: Record<string, unknown> | undefined;
    const provider = adapter.createProvider((req) => {
      captured = req.body;
      return adapter.successResponse('ok');
    });

    await provider.chat([{ role: 'user', content: 'x' }]);

    expect(captured).toBeDefined();
    expect(sp.temperature(captured!)).toBeUndefined();
    if (sp.maxTokensAlwaysSent) {
      expect(sp.maxTokensEquivalent(captured!)).toBe(sp.defaultMaxTokens);
    } else {
      expect(sp.maxTokensEquivalent(captured!)).toBeUndefined();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Wrapper providers (rate-limited, health-tracking) must forward ChatOpts
// unchanged to the inner provider — a decorator silently dropping/mutating
// `temperature`/`maxTokens`/`num_ctx`-bearing opts on its way through would
// be the exact same silent-degradation class as the two bugs above, just at
// the decorator layer instead of inside a concrete provider's chat(). Both
// decorators wrap EVERY provider `buildLLMProvider()` constructs (see each
// module's own doc comment), so this is real production wiring, not a
// hypothetical.
// ─────────────────────────────────────────────────────────────────────────
describe('wrapper providers forward ChatOpts unchanged to the inner provider', () => {
  class CapturingProvider implements LLMProvider {
    readonly name: LLMProvider['name'] = 'ollama';
    readonly model = 'test-model';
    lastOpts: ChatOpts | undefined;

    async chat(_messages: ChatMsg[], opts?: ChatOpts): Promise<ChatResult> {
      this.lastOpts = opts;
      return { text: 'ok', usage: { in: 1, out: 1, usd: 0 } };
    }

    async health(): Promise<LLMHealth> {
      return { ok: true, model: this.model, latency_ms: 0 };
    }
  }

  it('RateLimitedLLMProvider passes temperature/maxTokens through unchanged', async () => {
    const inner = new CapturingProvider();
    // Huge rate/capacity so acquire() never actually waits in this test.
    const bucket = new TokenBucket(1_000_000, 1_000_000);
    const wrapped = new RateLimitedLLMProvider(inner, bucket);

    await wrapped.chat([{ role: 'user', content: 'x' }], { temperature: 0.42, maxTokens: 123 });

    expect(inner.lastOpts?.temperature).toBe(0.42);
    expect(inner.lastOpts?.maxTokens).toBe(123);
  });

  it('HealthTrackingLLMProvider passes temperature/maxTokens through unchanged on success', async () => {
    const inner = new CapturingProvider();
    const entry = createProviderHealthEntry();
    const wrapped = trackLLMProviderHealth(inner, entry);

    await wrapped.chat([{ role: 'user', content: 'x' }], { temperature: 0.61, maxTokens: 456 });

    expect(inner.lastOpts?.temperature).toBe(0.61);
    expect(inner.lastOpts?.maxTokens).toBe(456);
  });
});
