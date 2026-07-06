import { describe, it, expect } from 'vitest';
import {
  MockCrossEncoderProvider,
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

  it("throws a clear TODO error for provider: 'http' (not yet implemented)", () => {
    expect(() =>
      buildCrossEncoderProvider({ enabled: true, provider: 'http', topK: 50, timeoutMs: 300 }),
    ).toThrow(/not implemented/i);
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
    expect(a.score).toBe(1);
    expect(b.score).toBe(0);
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
  });
});
