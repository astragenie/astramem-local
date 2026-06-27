import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzureOpenAILLMProvider } from '../../src/providers/llm/azure-openai.js';
import { runLLMContractSuite } from './_contract-suite.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const FAKE_CREDS = {
  endpoint: 'https://my-resource.openai.azure.com',
  deployment: 'gpt-4.1',
  apiKey: 'test-key-abc',
};

function azureChatResponse(
  content: string,
  promptTokens = 10,
  completionTokens = 5,
) {
  return {
    status: 200,
    body: {
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    },
  };
}

function mockFetchSequence(
  responses: Array<{ status: number; body: unknown }>,
): typeof fetch {
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
describe('azure-llm', () => {
  let restoreGlobal: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreGlobal = () => { globalThis.fetch = original; };
  });

  afterEach(() => {
    restoreGlobal();
    vi.restoreAllMocks();
  });

  runLLMContractSuite('azure-openai', () => {
    globalThis.fetch = mockFetchSequence(
      Array.from({ length: 10 }, () => azureChatResponse('{"result":"ok"}', 10, 5)),
    );
    return new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
  });

  // ---------------------------------------------------------------------------
  // Behaviour tests
  // ---------------------------------------------------------------------------
  describe('chat()', () => {
    it('round-trip returns {text, usage: {in, out, usd > 0}}', async () => {
      globalThis.fetch = mockFetchSequence([azureChatResponse('hello', 1000, 500)]);
      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
      const res = await p.chat([{ role: 'user', content: 'hi' }]);
      expect(res.text).toBe('hello');
      expect(res.usage.in).toBe(1000);
      expect(res.usage.out).toBe(500);
      // gpt-4.1: 1000/1M * 2.50 + 500/1M * 10.00 = 0.0025 + 0.005 = 0.0075
      expect(res.usage.usd).toBeCloseTo(0.0075, 6);
    });

    it('sends response_format json_object when json:true', async () => {
      let captured: unknown;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(azureChatResponse('{}').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
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

      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/HTTP 401/);
      expect(callCount).toBe(1);
    });

    it('retries once on 5xx then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('internal server error', { status: 500 });
      }) as unknown as typeof fetch;

      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow();
      expect(callCount).toBe(2);
    });

    it('retries once on network failure then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch;

      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
      await expect(p.chat([{ role: 'user', content: 'x' }])).rejects.toThrow('ECONNRESET');
      expect(callCount).toBe(2);
    });

    it('succeeds on retry when first attempt is 5xx', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) return new Response('error', { status: 503 });
        return new Response(JSON.stringify(azureChatResponse('retried').body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.text).toBe('retried');
      expect(callCount).toBe(2);
    });

    it('usd is 0 for unknown model (not in pricing table)', async () => {
      globalThis.fetch = mockFetchSequence([azureChatResponse('hi', 10000, 5000)]);
      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'unknown-model-xyz' });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      expect(res.usage.usd).toBe(0);
    });

    it('gpt-4.1-mini uses cheaper pricing', async () => {
      globalThis.fetch = mockFetchSequence([azureChatResponse('hi', 1_000_000, 1_000_000)]);
      const p = new AzureOpenAILLMProvider({
        ...FAKE_CREDS,
        deployment: 'gpt-4.1-mini',
        model: 'gpt-4.1-mini',
      });
      const res = await p.chat([{ role: 'user', content: 'x' }]);
      // 1M in * 0.15 + 1M out * 0.60 = 0.75
      expect(res.usage.usd).toBeCloseTo(0.75, 6);
    });
  });

  describe('health()', () => {
    it('ok:true when Azure returns 200', async () => {
      globalThis.fetch = mockFetchSequence([azureChatResponse('pong', 1, 1)]);
      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.model).toBe('gpt-4.1');
    });

    it('ok:false on connection error', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const p = new AzureOpenAILLMProvider({ ...FAKE_CREDS, model: 'gpt-4.1' });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/ECONNREFUSED/);
    });
  });

  describe.skipIf(!process.env.INTEGRATION_LIVE)('live integration', () => {
    it('calls Azure OpenAI (needs AZURE_OPENAI_API_KEY + AZURE_OPENAI_ENDPOINT env)', async () => {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT ?? '';
      const apiKey = process.env.AZURE_OPENAI_API_KEY ?? '';
      const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? 'gpt-4.1-mini';
      if (!endpoint || !apiKey) return;
      const p = new AzureOpenAILLMProvider({ endpoint, deployment, apiKey, model: deployment });
      const h = await p.health();
      expect(h.ok).toBe(true);
    }, 15_000);
  });
});
