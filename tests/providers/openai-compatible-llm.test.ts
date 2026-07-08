import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleLLMProvider } from '../../src/providers/llm/openai-compatible.js';
import { runLLMContractSuite } from './_contract-suite.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const FAKE_CREDS = {
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o-mini',
  apiKey: 'sk-test-abc',
};

function chatResponse(content: string, promptTokens = 10, completionTokens = 5) {
  return {
    status: 200,
    body: {
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    },
  };
}

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>): typeof fetch {
  let idx = 0;
  return vi.fn(async (): Promise<Response> => {
    const resp = responses[idx] ?? responses.at(-1)!;
    idx++;
    return new Response(JSON.stringify(resp.body), {
      status: resp.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

// ---------------------------------------------------------------------------
// Contract suite
// ---------------------------------------------------------------------------
describe('openai-compatible-llm', () => {
  let restoreGlobal: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreGlobal = () => { globalThis.fetch = original; };
  });

  afterEach(() => {
    restoreGlobal();
    vi.restoreAllMocks();
  });

  runLLMContractSuite('openai-compatible', () => {
    globalThis.fetch = mockFetchSequence(
      Array.from({ length: 10 }, () => chatResponse('{"result":"ok"}', 10, 5)),
    );
    return new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
  });

  // ---------------------------------------------------------------------------
  // Behaviour tests
  // ---------------------------------------------------------------------------
  describe('chat()', () => {
    it('round-trip returns {text, usage: {in, out, usd}}', async () => {
      globalThis.fetch = mockFetchSequence([chatResponse('hello', 1000, 500)]);
      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
      const res = await p.chat([{ role: 'user', content: 'hi' }]);
      expect(res.text).toBe('hello');
      expect(res.usage.in).toBe(1000);
      expect(res.usage.out).toBe(500);
    });

    it('sends Authorization: Bearer <key> when apiKey configured', async () => {
      let captured: RequestInit | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = init as RequestInit;
        return new Response(JSON.stringify(chatResponse('hi').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
      await p.chat([{ role: 'user', content: 'x' }]);
      const headers = captured?.headers as Record<string, string>;
      expect(headers.authorization).toBe('Bearer sk-test-abc');
    });

    it('omits Authorization header when no apiKey configured', async () => {
      let captured: RequestInit | undefined;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = init as RequestInit;
        return new Response(JSON.stringify(chatResponse('hi').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OpenAICompatibleLLMProvider({ baseUrl: 'http://localhost:8000/v1', model: 'local-model' });
      await p.chat([{ role: 'user', content: 'x' }]);
      const headers = captured?.headers as Record<string, string>;
      expect(headers.authorization).toBeUndefined();
    });

    it('sends response_format json_object when json:true', async () => {
      let captured: unknown;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(chatResponse('{}').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
      await p.chat([{ role: 'user', content: 'x' }], { json: true });
      expect((captured as Record<string, unknown>).response_format).toEqual({ type: 'json_object' });
    });

    it('throws on 4xx without retry', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response(
          JSON.stringify({ error: { message: 'unauthorized' } }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 401/);
      expect(callCount).toBe(1);
    });

    it('retries once on 5xx then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('internal server error', { status: 500 });
      }) as unknown as typeof fetch;

      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow();
      expect(callCount).toBe(2);
    });

    it('usd is 0 for unknown model (not in pricing table)', async () => {
      globalThis.fetch = mockFetchSequence([chatResponse('hi', 10000, 5000)]);
      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS, model: 'llama-3.1-70b-versatile' });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.usage.usd).toBe(0);
    });
  });

  describe('health()', () => {
    it('ok:true when endpoint returns 200', async () => {
      globalThis.fetch = mockFetchSequence([chatResponse('pong', 1, 1)]);
      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.model).toBe('gpt-4o-mini');
    });

    it('ok:false on connection error', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const p = new OpenAICompatibleLLMProvider({ ...FAKE_CREDS });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/ECONNREFUSED/);
    });
  });

  describe.skipIf(!process.env.INTEGRATION_LIVE)('live integration', () => {
    it('calls a real OpenAI-compatible endpoint (needs OPENAI_COMPAT_BASE_URL + OPENAI_COMPAT_API_KEY env)', async () => {
      const baseUrl = process.env.OPENAI_COMPAT_BASE_URL ?? '';
      const apiKey = process.env.OPENAI_COMPAT_API_KEY ?? '';
      if (!baseUrl) return;
      const p = new OpenAICompatibleLLMProvider({ baseUrl, model: 'gpt-4o-mini', apiKey });
      const h = await p.health();
      expect(h.ok).toBe(true);
    }, 15_000);
  });
});
