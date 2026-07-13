// WS6 — multi-hop query decomposition (src/search/decompose.ts).
//
// AC: MockQueryDecomposer is deterministic and network-free.
// AC: getSubQueries cheap-skips short queries without calling the decomposer.
// AC: getSubQueries falls back to [] (never throws) on decomposer timeout or error.
// AC: getSubQueries de-dupes (case-insensitive) and drops an echo of the original query.
// AC: getSubQueries caps output at opts.maxSubQueries.
// AC: resolveDecomposeOpts(config) is undefined when config.multiHop.enabled is false (the default).
// AC: LlmQueryDecomposer parses a JSON array response and tolerates malformed output.

import { describe, it, expect, vi } from 'vitest';
import {
  MockQueryDecomposer,
  LlmQueryDecomposer,
  resolveDecomposeOpts,
  needsDecomposition,
  getSubQueries,
  type QueryDecomposer,
  type DecomposeOpts,
} from '../../src/search/decompose.js';
import { defaultConfig } from '../../src/config/config.js';
import type { LLMProvider, ChatResult } from '../../src/contracts/llm.js';

function fakeChatResult(text: string): ChatResult {
  return { text, usage: { in: 0, out: 0, usd: 0 } };
}

describe('MockQueryDecomposer', () => {
  const decomposer = new MockQueryDecomposer();

  it('is deterministic — same query yields the same sub-queries across calls', async () => {
    const query = 'What does the person who gave Melanie the painting do for work';
    const first = await decomposer.decompose(query);
    const second = await decomposer.decompose(query);
    expect(first).toEqual(second);
  });

  it('splits a compound multi-hop question into 2 sub-queries', async () => {
    const result = await decomposer.decompose('the person who gave Melanie the painting and what they do for work');
    expect(result.length).toBe(2);
  });

  it('returns [] for a short single-fact query with no relative-clause marker', async () => {
    const result = await decomposer.decompose('Melanie favorite color');
    expect(result).toEqual([]);
  });
});

describe('needsDecomposition (cheap-skip gate)', () => {
  it('rejects a query shorter than minQueryWords', () => {
    expect(needsDecomposition('short query', 6)).toBe(false);
  });

  it('accepts a query at/above minQueryWords', () => {
    expect(needsDecomposition('what does the person who gave the painting do', 6)).toBe(true);
  });
});

describe('getSubQueries', () => {
  function opts(decomposer: QueryDecomposer, overrides: Partial<DecomposeOpts> = {}): DecomposeOpts {
    return {
      decomposer,
      minQueryWords: 4,
      maxSubQueries: 3,
      maxSupplemental: 5,
      supplementalWeight: 0.5,
      timeoutMs: 200,
      ...overrides,
    };
  }

  it('never calls the decomposer for a query below minQueryWords (cheap-skip)', async () => {
    const decompose = vi.fn(async () => ['sub query one']);
    const decomposer: QueryDecomposer = { name: 'mock', decompose };
    const result = await getSubQueries('two words', opts(decomposer, { minQueryWords: 6 }));
    expect(result).toEqual([]);
    expect(decompose).not.toHaveBeenCalled();
  });

  it('returns [] and does not throw when the decomposer times out', async () => {
    const decomposer: QueryDecomposer = {
      name: 'mock',
      decompose: () => new Promise(resolve => setTimeout(() => resolve(['too late']), 5_000)),
    };
    const result = await getSubQueries('a sufficiently long multi word query here', opts(decomposer, { timeoutMs: 30 }));
    expect(result).toEqual([]);
  });

  it('returns [] and does not throw when the decomposer rejects', async () => {
    const decomposer: QueryDecomposer = {
      name: 'mock',
      decompose: async () => { throw new Error('boom'); },
    };
    const result = await getSubQueries('a sufficiently long multi word query here', opts(decomposer));
    expect(result).toEqual([]);
  });

  it('de-dupes case-insensitively and drops an echo of the original query', async () => {
    const decomposer: QueryDecomposer = {
      name: 'mock',
      decompose: async () => ['Sub Query A', 'sub query a', 'a sufficiently long multi word query here', 'Sub Query B'],
    };
    const result = await getSubQueries('a sufficiently long multi word query here', opts(decomposer));
    expect(result).toEqual(['Sub Query A', 'Sub Query B']);
  });

  it('caps output at maxSubQueries', async () => {
    const decomposer: QueryDecomposer = {
      name: 'mock',
      decompose: async () => ['sub a', 'sub b', 'sub c', 'sub d', 'sub e'],
    };
    const result = await getSubQueries('a sufficiently long multi word query here', opts(decomposer, { maxSubQueries: 2 }));
    expect(result.length).toBe(2);
  });
});

describe('resolveDecomposeOpts', () => {
  const fakeBuildLLMProvider = () => ({
    name: 'ollama' as const,
    model: 'fake',
    chat: async () => fakeChatResult('[]'),
    health: async () => ({ ok: true, model: 'fake', latency_ms: 0 }),
  });

  it('is undefined when config.multiHop.enabled is false (the default)', () => {
    const opts = resolveDecomposeOpts(defaultConfig(), fakeBuildLLMProvider);
    expect(opts).toBeUndefined();
  });

  it('builds a MockQueryDecomposer for provider: "mock" when enabled', () => {
    const cfg = defaultConfig();
    cfg.multiHop = { ...cfg.multiHop, enabled: true, provider: 'mock' };
    const opts = resolveDecomposeOpts(cfg, fakeBuildLLMProvider);
    expect(opts).toBeDefined();
    expect(opts!.decomposer.name).toBe('mock');
  });

  it('builds an LlmQueryDecomposer for provider: "llm" when enabled', () => {
    const cfg = defaultConfig();
    cfg.multiHop = { ...cfg.multiHop, enabled: true, provider: 'llm' };
    const opts = resolveDecomposeOpts(cfg, fakeBuildLLMProvider);
    expect(opts).toBeDefined();
    expect(opts!.decomposer.name).toBe('llm');
    expect(opts!.decomposer).toBeInstanceOf(LlmQueryDecomposer);
  });

  it('clamps an out-of-range supplementalWeight defensively', () => {
    const cfg = defaultConfig();
    cfg.multiHop = { ...cfg.multiHop, enabled: true, supplementalWeight: 5 };
    const opts = resolveDecomposeOpts(cfg, fakeBuildLLMProvider);
    expect(opts!.supplementalWeight).toBe(1);
  });
});

describe('LlmQueryDecomposer', () => {
  function providerReturning(text: string): LLMProvider {
    return {
      name: 'ollama',
      model: 'fake',
      chat: vi.fn(async () => fakeChatResult(text)),
      health: async () => ({ ok: true, model: 'fake', latency_ms: 0 }),
    };
  }

  it('parses a clean JSON array response', async () => {
    const provider = providerReturning('["who gave Melanie the painting", "what does that person do for work"]');
    const decomposer = new LlmQueryDecomposer(provider, 3);
    const result = await decomposer.decompose('what does the person who gave Melanie the painting do for work');
    expect(result).toEqual(['who gave Melanie the painting', 'what does that person do for work']);
  });

  it('returns [] for an empty-array response (single-hop verdict)', async () => {
    const provider = providerReturning('[]');
    const decomposer = new LlmQueryDecomposer(provider, 3);
    expect(await decomposer.decompose('a simple single-fact query')).toEqual([]);
  });

  it('returns [] (never throws) for malformed JSON', async () => {
    const provider = providerReturning('not json at all');
    const decomposer = new LlmQueryDecomposer(provider, 3);
    expect(await decomposer.decompose('anything')).toEqual([]);
  });

  it('returns [] for valid JSON that is not a string array', async () => {
    const provider = providerReturning('{"sub_queries": ["a", "b"]}');
    const decomposer = new LlmQueryDecomposer(provider, 3);
    expect(await decomposer.decompose('anything')).toEqual([]);
  });

  it('caps its own output at maxSubQueries', async () => {
    const provider = providerReturning('["a", "b", "c", "d"]');
    const decomposer = new LlmQueryDecomposer(provider, 2);
    expect(await decomposer.decompose('anything')).toEqual(['a', 'b']);
  });

  it('calls chat with json:true and temperature 0 for determinism', async () => {
    const provider = providerReturning('[]');
    const decomposer = new LlmQueryDecomposer(provider, 3);
    await decomposer.decompose('anything');
    expect(provider.chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ json: true, temperature: 0 }),
    );
  });
});
