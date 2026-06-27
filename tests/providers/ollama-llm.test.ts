import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaLLMProvider } from '../../src/providers/llm/ollama.js';
import { runLLMContractSuite } from './_contract-suite.js';

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------
function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIdx = 0;
  return vi.fn(async (_url: unknown, _init?: unknown): Promise<Response> => {
    const resp = responses[callIdx] ?? responses.at(-1)!;
    callIdx++;
    const bodyStr = JSON.stringify(resp.body);
    return new Response(bodyStr, {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  });
}

function chatResponse(content: string, promptTokens = 10, evalTokens = 5) {
  return {
    status: 200,
    body: {
      message: { role: 'assistant', content },
      prompt_eval_count: promptTokens,
      eval_count: evalTokens,
    },
  };
}

function tagsResponse(models: string[]) {
  return {
    status: 200,
    body: { models: models.map((name) => ({ name })) },
  };
}

// ---------------------------------------------------------------------------
// Contract suite — uses mocked successful round-trip
// ---------------------------------------------------------------------------
describe('ollama-llm', () => {
  let restoreGlobal: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreGlobal = () => { globalThis.fetch = original; };
  });

  afterEach(() => {
    restoreGlobal();
    vi.restoreAllMocks();
  });

  runLLMContractSuite('ollama', () => {
    // contract suite calls chat() + health() — wire both up
    const mock = vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/api/tags')) {
        return new Response(JSON.stringify(tagsResponse(['qwen2.5-coder:7b']).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(chatResponse('{"result":"ok"}').body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    return new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
  });

  // ---------------------------------------------------------------------------
  // Detailed behaviour tests
  // ---------------------------------------------------------------------------
  describe('chat()', () => {
    it('round-trip returns {text, usage: {in, out, usd:0}}', async () => {
      globalThis.fetch = mockFetch([chatResponse('hello', 20, 8)]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const res = await p.chat([{ role: 'user', content: 'hi' }]);
      expect(res.text).toBe('hello');
      expect(res.usage.in).toBe(20);
      expect(res.usage.out).toBe(8);
      expect(res.usage.usd).toBe(0);
    });

    it('sends format:json when json option is true', async () => {
      let captured: unknown;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(chatResponse('{}').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await p.chat([{ role: 'user', content: 'x' }], { json: true });
      expect((captured as Record<string, unknown>).format).toBe('json');
    });

    it('throws on 4xx without retry', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response(JSON.stringify({ error: 'bad' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 400/);
      expect(callCount).toBe(1); // no retry
    });

    it('retries once on 5xx then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('internal error', { status: 500 });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow();
      expect(callCount).toBe(2); // retried once
    });

    it('retries once on network error then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow('ECONNREFUSED');
      expect(callCount).toBe(2);
    });

    it('succeeds on retry when first call is 5xx', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) return new Response('error', { status: 500 });
        return new Response(JSON.stringify(chatResponse('ok').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaLLMProvider({ model: 'test-model' });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.text).toBe('ok');
      expect(callCount).toBe(2);
    });
  });

  describe('health()', () => {
    it('returns ok:true when model present in tags', async () => {
      globalThis.fetch = mockFetch([tagsResponse(['qwen2.5-coder:7b', 'llama3'])]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.model).toBe('qwen2.5-coder:7b');
      expect(h.latency_ms).toBeGreaterThanOrEqual(0);
      expect(h.error).toBeUndefined();
    });

    it('returns ok:false when model not in tags', async () => {
      globalThis.fetch = mockFetch([tagsResponse(['llama3'])]) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/not found/);
    });

    it('returns ok:false on connection error', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/ECONNREFUSED/);
    });
  });

  // ---------------------------------------------------------------------------
  // Live integration (opt-in: INTEGRATION_LIVE=1)
  // ---------------------------------------------------------------------------
  describe.skipIf(!process.env.INTEGRATION_LIVE)('live integration', () => {
    it('actually calls ollama serve', async () => {
      const p = new OllamaLLMProvider({ model: 'qwen2.5-coder:7b' });
      const h = await p.health();
      expect(h.ok).toBe(true);
    }, 10_000);
  });
});
