import { describe, it, expect, afterEach } from 'vitest';
import {
  TokenBucket,
  rateLimitLLMProvider,
  RateLimitedLLMProvider,
  __resetRateLimitBucketsForTest,
} from '../../src/providers/llm/rate-limited.js';
import type { ChatMsg, ChatOpts, ChatResult, LLMHealth, LLMProvider } from '../../src/contracts/llm.js';

afterEach(() => __resetRateLimitBucketsForTest());

class FakeProvider implements LLMProvider {
  readonly name: LLMProvider['name'];
  chats = 0;
  healths = 0;
  constructor(name: LLMProvider['name'] = 'codex-subscription', readonly model = 'test') {
    this.name = name;
  }
  async chat(_m: ChatMsg[], _o?: ChatOpts): Promise<ChatResult> {
    this.chats++;
    return { text: 'ok', usage: { in: 0, out: 0, usd: 0 } };
  }
  async health(): Promise<LLMHealth> {
    this.healths++;
    return { ok: true, model: this.model, latency_ms: 1 };
  }
}

/** Deterministic clock + sleep that advances the clock instead of real waiting. */
function fakeClock() {
  let t = 0;
  const now = () => t;
  const sleep = async (ms: number) => { t += ms; };
  const advance = (ms: number) => { t += ms; };
  return { now, sleep, advance };
}

describe('TokenBucket', () => {
  it('allows an immediate burst up to capacity then throttles to the refill rate', async () => {
    const clk = fakeClock();
    // 60/min = 1/sec, capacity 3.
    const b = new TokenBucket(60, 3, clk.now, clk.sleep);
    // 3 immediate (burst), no clock movement.
    await b.acquire(); await b.acquire(); await b.acquire();
    expect(clk.now()).toBe(0);
    // 4th must wait ~1s (1 token at 1/sec) — acquire advances the fake clock.
    await b.acquire();
    expect(clk.now()).toBeGreaterThanOrEqual(1000);
  });

  it('never banks beyond capacity while idle', async () => {
    const clk = fakeClock();
    const b = new TokenBucket(60, 5, clk.now, clk.sleep);
    await b.acquire(); // consume 1 (4 left)
    clk.advance(100_000); // idle 100s would refill 100 tokens, but cap is 5
    expect(b.availableTokens()).toBe(5);
  });

  it('aborts a waiting acquire when the signal fires', async () => {
    const clk = fakeClock();
    const b = new TokenBucket(1, 1, clk.now, clk.sleep); // 1/min, tiny
    await b.acquire(); // consume the one token
    const ac = new AbortController();
    ac.abort(new Error('caller timeout'));
    await expect(b.acquire(ac.signal)).rejects.toThrow('caller timeout');
  });
});

describe('rateLimitLLMProvider', () => {
  it('returns the provider unchanged when disabled (0 / undefined)', () => {
    const p = new FakeProvider();
    expect(rateLimitLLMProvider(p, 0)).toBe(p);
    expect(rateLimitLLMProvider(p, undefined)).toBe(p);
  });

  it('wraps when enabled and preserves name/model; health() is never throttled', async () => {
    const p = new FakeProvider();
    const wrapped = rateLimitLLMProvider(p, 60);
    expect(wrapped).toBeInstanceOf(RateLimitedLLMProvider);
    expect(wrapped.name).toBe('codex-subscription');
    expect(wrapped.model).toBe('test');
    // health passes straight through
    await wrapped.health();
    await wrapped.health();
    expect(p.healths).toBe(2);
  });

  it('shares ONE bucket across providers of the same name (global budget)', () => {
    const a = new FakeProvider('codex-subscription', 'm1');
    const b = new FakeProvider('codex-subscription', 'm2');
    const wa = rateLimitLLMProvider(a, 60) as RateLimitedLLMProvider;
    const wb = rateLimitLLMProvider(b, 60) as RateLimitedLLMProvider;
    // Both wrappers must reference the same shared bucket instance.
    expect((wa as unknown as { bucket: unknown }).bucket).toBe(
      (wb as unknown as { bucket: unknown }).bucket,
    );
  });

  it('keeps separate buckets per provider name', () => {
    const codex = rateLimitLLMProvider(new FakeProvider('codex-subscription'), 60) as RateLimitedLLMProvider;
    const ollama = rateLimitLLMProvider(new FakeProvider('ollama'), 60) as RateLimitedLLMProvider;
    expect((codex as unknown as { bucket: unknown }).bucket).not.toBe(
      (ollama as unknown as { bucket: unknown }).bucket,
    );
  });
});
