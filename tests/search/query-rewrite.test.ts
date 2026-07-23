// FEAT-550 — query rewrite/expansion (src/search/query-rewrite.ts).
//
// AC-1: MockQueryRewriter is deterministic and network-free; resolveQueryRewriteOpts(config)
//       is undefined when config.search.queryRewrite.mode is 'off' (the default).
// AC-2/AC-5: getQueryVariants falls back to [] (never throws) on rewriter timeout, error,
//       or a "succeeded but useless" (empty/echo) result — the fail-open contract is the
//       same code path for all three cases.
// AC-3: mergeVariantHits merges by atom id keeping the MAX score, always includes the
//       primary hits, and caps the union at maxCandidates.

import { describe, it, expect, vi } from 'vitest';
import {
  MockQueryRewriter,
  LlmQueryRewriter,
  resolveQueryRewriteOpts,
  getQueryVariants,
  mergeVariantHits,
  type QueryRewriter,
  type QueryRewriteOpts,
} from '../../src/search/query-rewrite.js';
import type { FusedHit } from '../../src/search/fuse.js';
import { defaultConfig } from '../../src/config/config.js';
import type { LLMProvider, ChatResult } from '../../src/contracts/llm.js';

function fakeChatResult(text: string): ChatResult {
  return { text, usage: { in: 0, out: 0, usd: 0 } };
}

function hit(id: string, score: number, source: FusedHit['source'] = 'both'): FusedHit {
  return { id, score, source };
}

describe('MockQueryRewriter', () => {
  const rewriter = new MockQueryRewriter();

  it('is deterministic — same query yields the same variants across calls', async () => {
    const query = 'what did Melanie name her cat';
    const first = await rewriter.rewrite(query);
    const second = await rewriter.rewrite(query);
    expect(first).toEqual(second);
  });

  it('produces at least one variant for a normal query', async () => {
    const result = await rewriter.rewrite('what did Melanie name her cat');
    expect(result.length).toBeGreaterThan(0);
  });

  it('returns [] for a blank query', async () => {
    expect(await rewriter.rewrite('   ')).toEqual([]);
  });
});

describe('resolveQueryRewriteOpts', () => {
  const fakeBuildLLMProvider = () => ({
    name: 'ollama' as const,
    model: 'fake',
    chat: async () => fakeChatResult('[]'),
    health: async () => ({ ok: true, model: 'fake', latency_ms: 0 }),
  });

  it('is undefined when config.search.queryRewrite.mode is "off" (the default)', () => {
    const opts = resolveQueryRewriteOpts(defaultConfig(), fakeBuildLLMProvider);
    expect(opts).toBeUndefined();
  });

  it('builds a MockQueryRewriter for provider: "mock" when enabled', () => {
    const cfg = defaultConfig();
    cfg.search = { ...cfg.search, queryRewrite: { ...cfg.search.queryRewrite, mode: 'enabled', provider: 'mock' } };
    const opts = resolveQueryRewriteOpts(cfg, fakeBuildLLMProvider);
    expect(opts).toBeDefined();
    expect(opts!.rewriter.name).toBe('mock');
  });

  it('builds an LlmQueryRewriter for provider: "llm" when enabled', () => {
    const cfg = defaultConfig();
    cfg.search = { ...cfg.search, queryRewrite: { ...cfg.search.queryRewrite, mode: 'enabled', provider: 'llm' } };
    const opts = resolveQueryRewriteOpts(cfg, fakeBuildLLMProvider);
    expect(opts).toBeDefined();
    expect(opts!.rewriter.name).toBe('llm');
    expect(opts!.rewriter).toBeInstanceOf(LlmQueryRewriter);
  });

  it('threads maxVariants/timeoutMs/maxCandidates through from config', () => {
    const cfg = defaultConfig();
    cfg.search = {
      ...cfg.search,
      queryRewrite: { mode: 'enabled', provider: 'mock', maxVariants: 7, timeoutMs: 999, maxCandidates: 42 },
    };
    const opts = resolveQueryRewriteOpts(cfg, fakeBuildLLMProvider);
    expect(opts).toEqual(
      expect.objectContaining({ maxVariants: 7, timeoutMs: 999, maxCandidates: 42 }),
    );
  });
});

describe('getQueryVariants', () => {
  function opts(rewriter: QueryRewriter, overrides: Partial<QueryRewriteOpts> = {}): QueryRewriteOpts {
    return {
      rewriter,
      maxVariants: 3,
      timeoutMs: 200,
      maxCandidates: 100,
      ...overrides,
    };
  }

  it('returns [] and does not throw when the rewriter times out (AC-2)', async () => {
    const rewriter: QueryRewriter = {
      name: 'mock',
      rewrite: () => new Promise(resolve => setTimeout(() => resolve(['too late']), 5_000)),
    };
    const result = await getQueryVariants('a query', opts(rewriter, { timeoutMs: 30 }));
    expect(result).toEqual([]);
  });

  it('returns [] and does not throw when the rewriter rejects (AC-2)', async () => {
    const rewriter: QueryRewriter = {
      name: 'mock',
      rewrite: async () => { throw new Error('boom'); },
    };
    const result = await getQueryVariants('a query', opts(rewriter));
    expect(result).toEqual([]);
  });

  it('returns [] when the rewriter succeeds but produces only an echo of the original query (AC-5)', async () => {
    const rewriter: QueryRewriter = {
      name: 'mock',
      rewrite: async () => ['A Query', 'a query'],
    };
    const result = await getQueryVariants('a query', opts(rewriter));
    expect(result).toEqual([]);
  });

  it('returns [] when the rewriter succeeds but produces a degenerate (blank) result (AC-5)', async () => {
    const rewriter: QueryRewriter = {
      name: 'mock',
      rewrite: async () => ['', '   '],
    };
    const result = await getQueryVariants('a query', opts(rewriter));
    expect(result).toEqual([]);
  });

  it('de-dupes case-insensitively and drops an echo of the original query', async () => {
    const rewriter: QueryRewriter = {
      name: 'mock',
      rewrite: async () => ['Variant A', 'variant a', 'a query', 'Variant B'],
    };
    const result = await getQueryVariants('a query', opts(rewriter));
    expect(result).toEqual(['Variant A', 'Variant B']);
  });

  it('caps output at maxVariants', async () => {
    const rewriter: QueryRewriter = {
      name: 'mock',
      rewrite: async () => ['v1', 'v2', 'v3', 'v4', 'v5'],
    };
    const result = await getQueryVariants('a query', opts(rewriter, { maxVariants: 2 }));
    expect(result.length).toBe(2);
  });

  it('a timeout actually CANCELS the rewriter (fires its signal) instead of abandoning it', async () => {
    let sawAbort = false;
    let completed = false;
    const rewriter: QueryRewriter = {
      name: 'mock',
      rewrite: (_query, signal) =>
        new Promise<string[]>((resolve) => {
          const t = setTimeout(() => {
            completed = true;
            resolve(['too late']);
          }, 200);
          signal?.addEventListener('abort', () => {
            sawAbort = true;
            clearTimeout(t);
          });
        }),
    };

    const result = await getQueryVariants('a query', opts(rewriter, { timeoutMs: 20 }));
    expect(result).toEqual([]);
    expect(sawAbort).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect(completed).toBe(false);
  });
});

describe('mergeVariantHits (AC-3)', () => {
  it('keeps the MAX score across primary and variant lists for the same id', () => {
    const primary = [hit('a', 0.5), hit('b', 0.9)];
    const variants = [[hit('a', 0.8)], [hit('a', 0.3)]];
    const merged = mergeVariantHits(primary, variants, 100);
    const a = merged.find(h => h.id === 'a')!;
    expect(a.score).toBe(0.8);
  });

  it('always includes the primary hits in the union even when every variant returns zero hits', () => {
    const primary = [hit('a', 0.5), hit('b', 0.9)];
    const merged = mergeVariantHits(primary, [], 100);
    expect(merged.map(h => h.id).sort()).toEqual(['a', 'b']);
  });

  it('adds new ids a variant found that the primary pass never found', () => {
    const primary = [hit('a', 0.5)];
    const variants = [[hit('c', 0.4)]];
    const merged = mergeVariantHits(primary, variants, 100);
    expect(merged.map(h => h.id).sort()).toEqual(['a', 'c']);
  });

  it('caps the merged union at maxCandidates, keeping the highest-scoring ids', () => {
    const primary = [hit('a', 0.9), hit('b', 0.1)];
    const variants = [[hit('c', 0.8), hit('d', 0.7)]];
    const merged = mergeVariantHits(primary, variants, 3);
    expect(merged.length).toBe(3);
    expect(merged.map(h => h.id)).toEqual(['a', 'c', 'd']); // b (0.1) is displaced by the cap
  });

  it('returns results sorted by score descending', () => {
    const primary = [hit('a', 0.3)];
    const variants = [[hit('b', 0.9), hit('c', 0.5)]];
    const merged = mergeVariantHits(primary, variants, 100);
    expect(merged.map(h => h.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('LlmQueryRewriter', () => {
  function providerReturning(text: string): LLMProvider {
    return {
      name: 'ollama',
      model: 'fake',
      chat: vi.fn(async () => fakeChatResult(text)),
      health: async () => ({ ok: true, model: 'fake', latency_ms: 0 }),
    };
  }

  it('parses a clean JSON array response', async () => {
    const provider = providerReturning('["Melanie cat name", "what is Melanie\'s cat called"]');
    const rewriter = new LlmQueryRewriter(provider, 3);
    const result = await rewriter.rewrite('what did Melanie name her cat');
    expect(result).toEqual(['Melanie cat name', "what is Melanie's cat called"]);
  });

  it('returns [] for an empty-array response', async () => {
    const provider = providerReturning('[]');
    const rewriter = new LlmQueryRewriter(provider, 3);
    expect(await rewriter.rewrite('a simple query')).toEqual([]);
  });

  it('returns [] (never throws) for malformed JSON', async () => {
    const provider = providerReturning('not json at all');
    const rewriter = new LlmQueryRewriter(provider, 3);
    expect(await rewriter.rewrite('anything')).toEqual([]);
  });

  it('tolerates a JSON OBJECT response by taking its keys as variants', async () => {
    const provider = providerReturning('{"Melanie cat name": "unknown", "Melanie pet name": "unknown"}');
    const rewriter = new LlmQueryRewriter(provider, 3);
    expect(await rewriter.rewrite('anything')).toEqual(['Melanie cat name', 'Melanie pet name']);
  });

  it('caps its own output at maxVariants', async () => {
    const provider = providerReturning('["a", "b", "c", "d"]');
    const rewriter = new LlmQueryRewriter(provider, 2);
    expect(await rewriter.rewrite('anything')).toEqual(['a', 'b']);
  });

  it('calls chat with json:true, temperature 0, and a jsonSchema array constraint', async () => {
    const provider = providerReturning('[]');
    const rewriter = new LlmQueryRewriter(provider, 3);
    await rewriter.rewrite('anything');
    expect(provider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      // retrieval hardening (P2 2026-07): maxItems now mirrors the
      // constructor's maxVariants — constrains the schema itself, not
      // just the post-hoc .slice(0, maxVariants) truncation (mirrors
      // decompose.ts's LlmQueryDecomposer.decompose's identical guard).
      expect.objectContaining({
        json: true,
        temperature: 0,
        jsonSchema: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      }),
    );
  });

  it('forwards a caller-supplied AbortSignal through to provider.chat', async () => {
    const provider = providerReturning('[]');
    const rewriter = new LlmQueryRewriter(provider, 3);
    const controller = new AbortController();
    await rewriter.rewrite('anything', controller.signal);
    expect(provider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});
