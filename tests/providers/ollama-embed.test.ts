import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OllamaEmbedProvider } from '../../src/providers/embed/ollama.js';
import { runEmbedContractSuite } from './_contract-suite.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeEmbedVec(dim = 1024, seed = 0): number[] {
  return Array.from({ length: dim }, (_, i) => Math.sin(seed + i * 0.001));
}

function embedResponse(vecs: number[][]) {
  // Ollama /api/embeddings returns one embedding per call
  return vecs.map((embedding) => ({
    status: 200,
    body: { embedding },
  }));
}

function tagsResponse(models: string[]) {
  return {
    status: 200,
    body: { models: models.map((name) => ({ name })) },
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
describe('ollama-embed', () => {
  let restoreGlobal: () => void;

  beforeEach(() => {
    const original = globalThis.fetch;
    restoreGlobal = () => { globalThis.fetch = original; };
  });

  afterEach(() => {
    restoreGlobal();
    vi.restoreAllMocks();
  });

  runEmbedContractSuite('ollama', () => {
    // contract suite calls embed(['hello world', 'second text']) + embed(['single']) + health()
    // Ollama sends one request per text — need to intercept by URL
    const mock = vi.fn(async (url: string): Promise<Response> => {
      if (String(url).includes('/api/tags')) {
        return new Response(JSON.stringify(tagsResponse(['nomic-embed-text-v2-moe']).body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // embed request
      return new Response(JSON.stringify({ embedding: makeEmbedVec(1024) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    globalThis.fetch = mock as unknown as typeof fetch;
    return new OllamaEmbedProvider({ model: 'nomic-embed-text-v2-moe' });
  });

  // ---------------------------------------------------------------------------
  // Detailed behaviour tests
  // ---------------------------------------------------------------------------
  describe('embed()', () => {
    it('returns Float32Array[] length 1024 for each input', async () => {
      globalThis.fetch = mockFetchSequence(embedResponse([makeEmbedVec(1024, 0), makeEmbedVec(1024, 1)]));
      const p = new OllamaEmbedProvider({ model: 'nomic-embed-text-v2-moe' });
      const results = await p.embed(['text one', 'text two']);
      expect(results).toHaveLength(2);
      for (const arr of results) {
        expect(arr).toBeInstanceOf(Float32Array);
        expect(arr.length).toBe(1024);
      }
    });

    it('throws when dim !== 1024', async () => {
      // Mock returns wrong-dim vector
      globalThis.fetch = mockFetchSequence([{ status: 200, body: { embedding: makeEmbedVec(768) } }]);
      const p = new OllamaEmbedProvider({ model: 'nomic-embed-text-v2-moe' });
      await expect(p.embed(['text'])).rejects.toThrow(/dimension mismatch.*expected 1024.*got 768/i);
    });

    it('throws on 4xx without retry', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('not found', { status: 404 });
      }) as unknown as typeof fetch;

      const p = new OllamaEmbedProvider({ model: 'test-model' });
      await expect(p.embed(['x'])).rejects.toThrow(/HTTP 404/);
      expect(callCount).toBe(1);
    });

    it('retries once on 5xx then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        return new Response('server error', { status: 500 });
      }) as unknown as typeof fetch;

      const p = new OllamaEmbedProvider({ model: 'test-model' });
      await expect(p.embed(['x'])).rejects.toThrow();
      expect(callCount).toBe(2);
    });

    it('retries once on network failure then throws', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const p = new OllamaEmbedProvider({ model: 'test-model' });
      await expect(p.embed(['x'])).rejects.toThrow('ECONNREFUSED');
      expect(callCount).toBe(2);
    });

    it('succeeds on retry when first call is 5xx', async () => {
      let callCount = 0;
      globalThis.fetch = vi.fn(async () => {
        callCount++;
        if (callCount === 1) return new Response('error', { status: 500 });
        return new Response(JSON.stringify({ embedding: makeEmbedVec(1024) }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch;

      const p = new OllamaEmbedProvider({ model: 'test-model' });
      const res = await p.embed(['x']);
      expect(res[0].length).toBe(1024);
      expect(callCount).toBe(2);
    });
  });

  describe('health()', () => {
    it('ok:true when model in tags', async () => {
      globalThis.fetch = mockFetchSequence([tagsResponse(['nomic-embed-text-v2-moe'])]);
      const p = new OllamaEmbedProvider({ model: 'nomic-embed-text-v2-moe' });
      const h = await p.health();
      expect(h.ok).toBe(true);
      expect(h.dim).toBe(1024);
    });

    it('ok:false when model missing', async () => {
      globalThis.fetch = mockFetchSequence([tagsResponse(['llama3'])]);
      const p = new OllamaEmbedProvider({ model: 'nomic-embed-text-v2-moe' });
      const h = await p.health();
      expect(h.ok).toBe(false);
    });
  });

  describe.skipIf(!process.env.INTEGRATION_LIVE)('live integration', () => {
    it('actually calls ollama embeddings', async () => {
      const p = new OllamaEmbedProvider({ model: 'nomic-embed-text-v2-moe' });
      const vecs = await p.embed(['hello from integration test']);
      expect(vecs[0].length).toBe(1024);
    }, 15_000);
  });
});
