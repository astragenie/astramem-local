import { describe, it, expect, vi } from 'vitest';
import {
  MockCrossEncoderProvider,
  HttpCrossEncoderProvider,
  applyRerank,
  buildCrossEncoderProvider,
  resolveRerankOpts,
  type CrossEncoderProvider,
  type RerankOpts,
} from '../../src/search/rerank.js';
import { defaultConfig } from '../../src/config/config.js';

type Hit = { id: string; text: string; score: number };

describe('MockCrossEncoderProvider', () => {
  const provider = new MockCrossEncoderProvider();

  it('is deterministic — same query/candidates yield the same scores across calls', async () => {
    const candidates = [
      { id: 'a', text: 'bun run test uses vitest', fusedScore: 0.5 },
      { id: 'b', text: 'completely unrelated banana bread recipe', fusedScore: 0.6 },
    ];
    const first = await provider.score('bun test vitest', candidates);
    const second = await provider.score('bun test vitest', candidates);
    expect([...first.entries()]).toEqual([...second.entries()]);
  });

  it('scores higher lexical overlap above lower overlap', async () => {
    const candidates = [
      { id: 'high', text: 'sqlite vec bm25 fusion hybrid search', fusedScore: 0 },
      { id: 'low', text: 'a completely different topic about cooking', fusedScore: 0 },
    ];
    const scores = await provider.score('sqlite vec hybrid search', candidates);
    expect(scores.get('high')!).toBeGreaterThan(scores.get('low')!);
  });

  it('every score is in [0,1]', async () => {
    const candidates = [
      { id: 'a', text: 'x y z', fusedScore: 0 },
      { id: 'b', text: '', fusedScore: 0 },
    ];
    const scores = await provider.score('x y z', candidates);
    for (const s of scores.values()) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('empty query and empty candidate text both yield 0 (no shared tokens)', async () => {
    const scores = await provider.score('', [{ id: 'a', text: '', fusedScore: 0 }]);
    expect(scores.get('a')).toBe(0);
  });
});

describe('buildCrossEncoderProvider', () => {
  it("builds a MockCrossEncoderProvider for provider: 'mock'", () => {
    const provider = buildCrossEncoderProvider({ enabled: true, provider: 'mock', topK: 50, timeoutMs: 300 });
    expect(provider.name).toBe('mock');
  });

  it("throws a clear config error for provider: 'http' when sidecarUrl is unset", () => {
    expect(() =>
      buildCrossEncoderProvider({ enabled: true, provider: 'http', topK: 50, timeoutMs: 300 }),
    ).toThrow(/sidecarUrl/i);
  });

  it("builds a live HttpCrossEncoderProvider for provider: 'http' when sidecarUrl is set", () => {
    const provider = buildCrossEncoderProvider({
      enabled: true,
      provider: 'http',
      topK: 50,
      timeoutMs: 300,
      sidecarUrl: 'http://127.0.0.1:9000/rerank',
      model: 'bge-reranker-v2-m3',
    });
    expect(provider.name).toBe('http');
    expect(provider).toBeInstanceOf(HttpCrossEncoderProvider);
  });
});

describe('resolveRerankOpts', () => {
  it('returns undefined when crossEncoder.enabled is false (the default)', () => {
    expect(resolveRerankOpts(defaultConfig())).toBeUndefined();
  });

  it('returns a RerankOpts with a live provider when enabled', () => {
    const cfg = { ...defaultConfig(), crossEncoder: { enabled: true, provider: 'mock' as const, topK: 7, timeoutMs: 123 } };
    const opts = resolveRerankOpts(cfg);
    expect(opts).toBeDefined();
    expect(opts?.topK).toBe(7);
    expect(opts?.timeoutMs).toBe(123);
    expect(opts?.provider.name).toBe('mock');
  });
});

describe('HttpCrossEncoderProvider', () => {
  const candidates = [
    { id: 'a', text: 'sqlite vec hybrid bm25 fusion search', fusedScore: 0.1 },
    { id: 'b', text: 'completely unrelated banana bread recipe', fusedScore: 0.9 },
  ];

  it('parses a bare TEI-style array response ([{index,score}]) into id-keyed scores', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([{ index: 1, score: 0.2 }, { index: 0, score: 0.95 }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl });

    const scores = await provider.score('sqlite vec hybrid search', candidates);

    expect(scores.get('a')).toBe(0.95);
    expect(scores.get('b')).toBe(0.2);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://sidecar/rerank');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({ query: 'sqlite vec hybrid search', texts: candidates.map(c => c.text) });
  });

  it('parses a wrapped {results:[{index,score}]} response', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ results: [{ index: 0, score: 0.5 }, { index: 1, score: 0.1 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl });

    const scores = await provider.score('query', candidates);

    expect(scores.get('a')).toBe(0.5);
    expect(scores.get('b')).toBe(0.1);
  });

  it('forwards the configured model in the request body when set', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', model: 'bge-reranker-v2-m3', fetchImpl });

    await provider.score('query', candidates);

    const [, init] = vi.mocked(fetchImpl).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('bge-reranker-v2-m3');
  });

  it('returns an empty map without calling fetch when there are no candidates', async () => {
    const fetchImpl = vi.fn();
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl: fetchImpl as unknown as typeof fetch });

    const scores = await provider.score('query', []);

    expect(scores.size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response (caller — applyRerank — is responsible for fallback)', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('internal error', { status: 500 }),
    ) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl });

    await expect(provider.score('query', candidates)).rejects.toThrow(/500/);
  });

  it('throws when the fetch call itself rejects (network error)', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl });

    await expect(provider.score('query', candidates)).rejects.toThrow(/ECONNREFUSED/);
  });

  it('throws when the response body has no parseable results array', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl });

    await expect(provider.score('query', candidates)).rejects.toThrow(/results array/i);
  });

  it('end-to-end via applyRerank: HTTP error falls back to the un-reranked fused order (never fails the search)', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 502 })) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl });
    const hits = [
      { id: 'a', text: candidates[0]!.text, score: 0.1 },
      { id: 'b', text: candidates[1]!.text, score: 0.9 },
    ];
    const opts: RerankOpts = { topK: 10, timeoutMs: 300, provider };

    const result = await applyRerank('query', hits, opts);

    expect(result).toEqual(hits);
  });

  it('end-to-end via applyRerank: a slow HTTP provider times out and falls back to the un-reranked fused order', async () => {
    const fetchImpl = vi.fn(
      () => new Promise<Response>(resolve => setTimeout(
        () => resolve(new Response(JSON.stringify([]), { status: 200 })),
        50,
      )),
    ) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', fetchImpl });
    const hits = [
      { id: 'a', text: candidates[0]!.text, score: 0.1 },
      { id: 'b', text: candidates[1]!.text, score: 0.9 },
    ];
    const opts: RerankOpts = { topK: 10, timeoutMs: 5, provider };

    const result = await applyRerank('query', hits, opts);

    expect(result).toEqual(hits);
  });

  // Issue #261: proves HttpCrossEncoderProvider.score() actually wires a
  // caller-supplied signal into the outgoing fetch, combined with (not
  // replacing) its own internal AbortSignal.timeout ceiling. The provider's
  // own ceiling here is a generous 60s — only the caller's controller can
  // explain a cancellation this fast.
  it('issue #261: combines a caller signal with its own timeout — caller abort cancels the underlying fetch', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Promise<Response>((_, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'));
        });
      });
    }) as unknown as typeof fetch;
    const provider = new HttpCrossEncoderProvider({ url: 'http://sidecar/rerank', timeoutMs: 60_000, fetchImpl });

    const controller = new AbortController();
    const scorePromise = provider.score('query', candidates, controller.signal);
    controller.abort();

    await expect(scorePromise).rejects.toThrow();
    expect(capturedSignal?.aborted).toBe(true);
  });
});

describe('applyRerank', () => {
  const baseOpts: RerankOpts = { topK: 10, timeoutMs: 300, provider: new MockCrossEncoderProvider() };

  it('empty hit list returns empty, no provider call needed', async () => {
    const result = await applyRerank('query', [], baseOpts);
    expect(result).toEqual([]);
  });

  it('reorders the top-K window by cross-encoder score', async () => {
    const hits: Hit[] = [
      { id: 'irrelevant', text: 'zzz nothing to do with the query at all', score: 0.9 },
      { id: 'relevant', text: 'sqlite vec hybrid bm25 fusion search', score: 0.1 },
    ];
    const result = await applyRerank('sqlite vec hybrid search', hits, baseOpts);
    // Fused order had 'irrelevant' first (higher fused score); rerank should
    // promote the lexically-relevant candidate to the top despite its lower
    // fused score, proving the stage actually reorders rather than passing
    // through unchanged.
    expect(result[0]!.id).toBe('relevant');
  });

  it('leaves hits beyond topK untouched, in original order', async () => {
    const hits: Hit[] = [
      { id: 'h1', text: 'aaa', score: 0.5 },
      { id: 'h2', text: 'bbb', score: 0.4 },
      { id: 'tail1', text: 'ccc', score: 0.3 },
      { id: 'tail2', text: 'ddd', score: 0.2 },
    ];
    const opts: RerankOpts = { ...baseOpts, topK: 2 };
    const result = await applyRerank('query', hits, opts);
    expect(result.map(h => h.id).slice(2)).toEqual(['tail1', 'tail2']);
  });

  it('preserves array length — no hits dropped or duplicated', async () => {
    const hits: Hit[] = Array.from({ length: 8 }, (_, i) => ({ id: `id${i}`, text: `text ${i}`, score: 1 - i * 0.1 }));
    const opts: RerankOpts = { ...baseOpts, topK: 3 };
    const result = await applyRerank('text', hits, opts);
    expect(result).toHaveLength(hits.length);
    expect(new Set(result.map(h => h.id))).toEqual(new Set(hits.map(h => h.id)));
  });

  it('falls back to the original (un-reranked) order on provider timeout', async () => {
    const slowProvider: CrossEncoderProvider = {
      name: 'mock',
      score: () => new Promise(resolve => setTimeout(() => resolve(new Map([['a', 1]])), 50)),
    };
    const hits: Hit[] = [
      { id: 'a', text: 'a', score: 0.1 },
      { id: 'b', text: 'b', score: 0.9 },
    ];
    const opts: RerankOpts = { topK: 10, timeoutMs: 5, provider: slowProvider };
    const result = await applyRerank('query', hits, opts);
    expect(result).toEqual(hits);
  });

  it('falls back to the original order when the provider throws', async () => {
    const throwingProvider: CrossEncoderProvider = {
      name: 'mock',
      score: async () => { throw new Error('boom'); },
    };
    const hits: Hit[] = [
      { id: 'a', text: 'a', score: 0.1 },
      { id: 'b', text: 'b', score: 0.9 },
    ];
    const opts: RerankOpts = { topK: 10, timeoutMs: 300, provider: throwingProvider };
    const result = await applyRerank('query', hits, opts);
    expect(result).toEqual(hits);
  });

  // Issue #261 (Bug 1): the pre-fix `withTimeout` raced a promise against a
  // timer and, on timeout, simply ABANDONED the losing promise — the
  // provider's "work" (here, a background timer standing in for a real HTTP
  // cross-encoder call) kept running to completion after applyRerank had
  // already fallen back to the un-reranked order. This test fails against
  // the unfixed code: the old `score(query, candidates)` call site passed no
  // signal at all, so `signal` below would be `undefined`, `sawAbort` would
  // never become `true`, and the background timer would complete normally
  // 250ms later.
  it('issue #261: a timeout actually CANCELS the provider call (fires its signal) instead of abandoning it', async () => {
    let sawAbort = false;
    let completed = false;
    const slowProvider: CrossEncoderProvider = {
      name: 'mock',
      score: (_query, _candidates, signal) =>
        new Promise<Map<string, number>>((resolve) => {
          const t = setTimeout(() => {
            completed = true;
            resolve(new Map([['a', 1]]));
          }, 200);
          signal?.addEventListener('abort', () => {
            sawAbort = true;
            clearTimeout(t);
          });
        }),
    };
    const hits: Hit[] = [
      { id: 'a', text: 'a', score: 0.1 },
      { id: 'b', text: 'b', score: 0.9 },
    ];
    const opts: RerankOpts = { topK: 10, timeoutMs: 20, provider: slowProvider };

    const result = await applyRerank('query', hits, opts);
    expect(result).toEqual(hits);
    expect(sawAbort).toBe(true);

    // Give the (should-be-cancelled) background timer a chance to fire if it
    // was only abandoned rather than truly cancelled.
    await new Promise((r) => setTimeout(r, 250));
    expect(completed).toBe(false);
  });

  it('clamps out-of-range provider scores into [0,1] rather than propagating them raw', async () => {
    const wildProvider: CrossEncoderProvider = {
      name: 'mock',
      score: async () => new Map([['a', 42], ['b', -7]]),
    };
    const hits: Hit[] = [
      { id: 'a', text: 'a', score: 0.1 },
      { id: 'b', text: 'b', score: 0.2 },
    ];
    const opts: RerankOpts = { topK: 10, timeoutMs: 300, provider: wildProvider };
    const result = await applyRerank('query', hits, opts);
    const a = result.find(h => h.id === 'a')!;
    const b = result.find(h => h.id === 'b')!;
    // FEAT-452: `score` stays the original fused value — only `rerank_score`
    // (and the mirrored explanation.signals.cross_encoder.final) carries the
    // clamped cross-encoder verdict.
    expect(a.score).toBe(0.1);
    expect(b.score).toBe(0.2);
    expect(a.rerank_score).toBe(1);
    expect(b.rerank_score).toBe(0);
  });

  it('falls back to the original fused score for a candidate id missing from the provider result', async () => {
    const partialProvider: CrossEncoderProvider = {
      name: 'mock',
      score: async () => new Map([['a', 0.9]]), // 'b' intentionally missing
    };
    const hits: Hit[] = [
      { id: 'a', text: 'a', score: 0.1 },
      { id: 'b', text: 'b', score: 0.5 },
    ];
    const opts: RerankOpts = { topK: 10, timeoutMs: 300, provider: partialProvider };
    const result = await applyRerank('query', hits, opts);
    const b = result.find(h => h.id === 'b')!;
    expect(b.score).toBe(0.5); // unchanged — original fused score preserved
    expect(b.rerank_score).toBe(0.5); // fallback: rerank_score defaults to the fused score too
  });

  it('FEAT-452: a reranked hit carries reranked/rerank_score/explanation distinct from the untouched fused score', async () => {
    const provider: CrossEncoderProvider = {
      name: 'mock',
      score: async () => new Map([['a', 0.77]]),
    };
    const hits: Hit[] = [{ id: 'a', text: 'a', score: 0.33 }];
    const opts: RerankOpts = { topK: 10, timeoutMs: 300, provider };

    const [hit] = await applyRerank('query', hits, opts);

    expect(hit!.score).toBe(0.33); // fused score, untouched
    expect(hit!.reranked).toBe(true);
    expect(hit!.rerank_score).toBe(0.77);
    expect(hit!.explanation).toEqual({
      signals: { cross_encoder: { raw: 0.33, weight: 1, final: 0.77 } },
    });
  });

  it('FEAT-452: rerank off (no opts.rerank call at all) leaves plain hits with no rerank fields', async () => {
    // applyRerank is never invoked when rerank is disabled — this asserts
    // the shape of an ordinary (never-reranked) hit has none of the
    // additive fields, i.e. there is nothing to distinguish it from
    // pre-FEAT-452 output.
    const hit: Hit = { id: 'a', text: 'a', score: 0.5 };
    expect('reranked' in hit).toBe(false);
    expect('rerank_score' in hit).toBe(false);
    expect('explanation' in hit).toBe(false);
  });

  it('FEAT-452: hits beyond topK (untouched tail) carry no rerank fields either', async () => {
    const provider: CrossEncoderProvider = {
      name: 'mock',
      score: async () => new Map([['h1', 0.9]]),
    };
    const hits: Hit[] = [
      { id: 'h1', text: 'a', score: 0.5 },
      { id: 'tail', text: 'b', score: 0.4 },
    ];
    const opts: RerankOpts = { topK: 1, timeoutMs: 300, provider };
    const result = await applyRerank('query', hits, opts);
    const tail = result.find(h => h.id === 'tail')!;
    expect(tail.reranked).toBeUndefined();
    expect(tail.rerank_score).toBeUndefined();
    expect(tail.explanation).toBeUndefined();
  });

  it('FEAT-452: whole-call timeout fallback leaves hits completely unchanged — no rerank fields anywhere', async () => {
    const slowProvider: CrossEncoderProvider = {
      name: 'mock',
      score: () => new Promise(resolve => setTimeout(() => resolve(new Map([['a', 1]])), 50)),
    };
    const hits: Hit[] = [{ id: 'a', text: 'a', score: 0.1 }];
    const opts: RerankOpts = { topK: 10, timeoutMs: 5, provider: slowProvider };
    const result = await applyRerank('query', hits, opts);
    expect(result).toEqual(hits);
    expect(result[0]!.reranked).toBeUndefined();
  });
});
