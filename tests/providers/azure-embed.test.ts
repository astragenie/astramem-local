import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzureOpenAIEmbedProvider } from '../../src/providers/embed/azure-openai.js';
import { runEmbedContractSuite } from './_contract-suite.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const FAKE_CREDS = {
  endpoint: 'https://my-resource.openai.azure.com',
  deployment: 'text-embedding-3-small',
  apiKey: 'test-key-abc',
};

function makeVec(dim = 1024, seed = 0): number[] {
  return Array.from({ length: dim }, (_, i) => Math.cos(seed + i * 0.001));
}

function azureEmbedResponse(vecs: number[][]) {
  return {
    status: 200,
    body: {
      data: vecs.map((embedding, index) => ({ embedding, index, object: 'embedding' })),
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: vecs.length * 3, total_tokens: vecs.length * 3 },
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
describe('azure-embed', () => {
  let restoreGlobal: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreGlobal = () => { globalThis.fetch = original; };
  });

  afterEach(() => {
    restoreGlobal();
    vi.restoreAllMocks();
  });

  runEmbedContractSuite('azure-openai', () => {
    // Contract suite calls embed(['hello world', 'second text']), embed(['single']), health()
    globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown): Promise<Response> => {
      const body = JSON.parse((init as RequestInit).body as string) as { input: string[] };
      const vecs = (body.input ?? ['x']).map((_, i) => makeVec(1024, i));
      return new Response(JSON.stringify(azureEmbedResponse(vecs).body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;
    return new AzureOpenAIEmbedProvider({ ...FAKE_CREDS, model: 'text-embedding-3-small' });
  });

  // ---------------------------------------------------------------------------
  // Behaviour tests
  // ---------------------------------------------------------------------------
  describe('embed()', () => {
    it('returns Float32Array[] each length 1024 for batch input', async () => {
      globalThis.fetch = mockFetchSequence([
        azureEmbedResponse([makeVec(1024, 0), makeVec(1024, 1)]),
      ]);
      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS, model: 'text-embedding-3-small' });
      const results = await p.embed(['text one', 'text two']);
      expect(results).toHaveLength(2);
      for (const arr of results) {
        expect(arr).toBeInstanceOf(Float32Array);
        expect(arr.length).toBe(1024);
      }
    });

    it('sends dimensions:1024 in request', async () => {
      let captured: unknown;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        captured = JSON.parse((init as RequestInit).body as string);
        return new Response(JSON.stringify(azureEmbedResponse([makeVec(1024)]).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS, model: 'text-embedding-3-small' });
      await p.embed(['x']);
      expect((captured as Record<string, unknown>).dimensions).toBe(1024);
    });

    it('throws with helpful message when dim !== 1024 (wrong-dim from Azure)', async () => {
      globalThis.fetch = mockFetchSequence([
        azureEmbedResponse([makeVec(1536)]), // 1536 = text-embedding-ada-002 default
      ]);
      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS, model: 'text-embedding-3-small' });
      await expect(p.embed(['x'])).rejects.toThrow(/dimension mismatch.*expected 1024.*got 1536/i);
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

      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS });
      await expect(p.embed(['x'])).rejects.toThrow(/HTTP 401/);
      expect(callCount).toBe(1);
    });

    it('retries once on 5xx then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('internal server error', { status: 500 });
      }) as unknown as typeof fetch;

      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS });
      await expect(p.embed(['x'])).rejects.toThrow();
      expect(callCount).toBe(2);
    });

    it('retries once on network failure then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        throw new Error('ECONNRESET');
      }) as unknown as typeof fetch;

      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS });
      await expect(p.embed(['x'])).rejects.toThrow('ECONNRESET');
      expect(callCount).toBe(2);
    });

    it('succeeds on retry when first attempt is 5xx', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async (_url: unknown, init?: unknown) => {
        callCount++;
        if (callCount === 1) return new Response('server error', { status: 503 });
        const body = JSON.parse((init as RequestInit).body as string) as { input: string[] };
        const vecs = (body.input ?? ['x']).map(() => makeVec(1024));
        return new Response(JSON.stringify(azureEmbedResponse(vecs).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS });
      const res = await p.embed(['x']);
      expect(res[0].length).toBe(1024);
      expect(callCount).toBe(2);
    });

    it('preserves input order via index sort', async () => {
      // Return items out-of-order from Azure
      globalThis.fetch = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            data: [
              { embedding: makeVec(1024, 2), index: 2 },
              { embedding: makeVec(1024, 0), index: 0 },
              { embedding: makeVec(1024, 1), index: 1 },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }) as unknown as typeof fetch;

      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS });
      const res = await p.embed(['a', 'b', 'c']);
      // Should be sorted by index
      const expected0 = makeVec(1024, 0);
      expect(res[0][0]).toBeCloseTo(expected0[0], 10);
    });
  });

  describe('health()', () => {
    it('ok:true when Azure returns 200', async () => {
      globalThis.fetch = mockFetchSequence([azureEmbedResponse([makeVec(1024)])]);
      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS, model: 'text-embedding-3-small' });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.dim).toBe(1024);
      expect(h.model).toBe('text-embedding-3-small');
    });

    it('ok:false on connection error', async () => {
      globalThis.fetch = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
      const p = new AzureOpenAIEmbedProvider({ ...FAKE_CREDS });
      const h = await p.health();
      expect(h.ok).toBe(false);
      expect(h.error).toMatch(/ECONNREFUSED/);
    });
  });

  describe.skipIf(!process.env.INTEGRATION_LIVE)('live integration', () => {
    it('calls Azure embed (needs AZURE_OPENAI_API_KEY + endpoint)', async () => {
      const endpoint = process.env.AZURE_OPENAI_ENDPOINT ?? '';
      const apiKey = process.env.AZURE_OPENAI_API_KEY ?? '';
      const deployment = process.env.AZURE_EMBED_DEPLOYMENT ?? 'text-embedding-3-small';
      if (!endpoint || !apiKey) return;
      const p = new AzureOpenAIEmbedProvider({ endpoint, deployment, apiKey });
      const vecs = await p.embed(['integration test']);
      expect(vecs[0].length).toBe(1024);
    }, 15_000);
  });
});
