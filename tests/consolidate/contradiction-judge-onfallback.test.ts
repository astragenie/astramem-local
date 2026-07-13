/**
 * tests/consolidate/contradiction-judge-onfallback.test.ts
 *
 * Silent-error audit (2026-07-13): judgeContradiction() falls back to
 * FALLBACK_VERDICT ('unrelated', confidence 0) on a parse failure or a
 * thrown/rejected chat() call — by design, so a bad LLM response never
 * blocks a consolidation run. But nothing previously distinguished "the
 * judge genuinely found the pair unrelated" from "the judge call itself
 * failed and we silently defaulted" — a systemically broken judge provider
 * would look identical to "no contradictions found" (same shape as issues
 * #190/#200). `onFallback` closes that gap; this file is a pure unit test
 * against a FAKE LLMProvider (no real model, no Ollama — this repo's Ollama
 * is contended and LLM-dependent tests must not run against it).
 */
import { describe, it, expect, vi } from 'vitest';
import { judgeContradiction, type JudgeableAtom } from '../../src/consolidate/contradiction-judge.js';
import type { LLMProvider, ChatResult } from '../../src/contracts/llm.js';

function fakeProvider(chat: () => Promise<ChatResult>): LLMProvider {
  return {
    name: 'ollama',
    model: 'fake-test-model',
    chat,
    health: async () => ({ ok: true, model: 'fake-test-model', latency_ms: 0 }),
  };
}

const a: JudgeableAtom = { text: 'Port 7777 is the default.', created_at: 1000 };
const b: JudgeableAtom = { text: 'The default port is 8080.', created_at: 2000 };

describe('judgeContradiction onFallback', () => {
  it('a rejected chat() call falls back to unrelated AND calls onFallback', async () => {
    const provider = fakeProvider(async () => { throw new Error('provider unreachable'); });
    const onFallback = vi.fn();
    const verdict = await judgeContradiction(provider, a, b, { log: () => {}, onFallback });
    expect(verdict).toEqual({ verdict: 'unrelated', confidence: 0 });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('an unparsable response falls back to unrelated AND calls onFallback', async () => {
    const provider = fakeProvider(async () => ({ text: 'not json', usage: { in: 1, out: 1, usd: 0 } }));
    const onFallback = vi.fn();
    const verdict = await judgeContradiction(provider, a, b, { log: () => {}, onFallback });
    expect(verdict).toEqual({ verdict: 'unrelated', confidence: 0 });
    expect(onFallback).toHaveBeenCalledTimes(1);
  });

  it('a well-formed verdict does NOT call onFallback', async () => {
    const provider = fakeProvider(async () => ({
      text: JSON.stringify({ verdict: 'contradicts', confidence: 0.9 }),
      usage: { in: 1, out: 1, usd: 0 },
    }));
    const onFallback = vi.fn();
    const verdict = await judgeContradiction(provider, a, b, { log: () => {}, onFallback });
    expect(verdict).toEqual({ verdict: 'contradicts', confidence: 0.9 });
    expect(onFallback).not.toHaveBeenCalled();
  });

  it('onFallback is optional — omitting it does not throw', async () => {
    const provider = fakeProvider(async () => { throw new Error('provider unreachable'); });
    const verdict = await judgeContradiction(provider, a, b, { log: () => {} });
    expect(verdict).toEqual({ verdict: 'unrelated', confidence: 0 });
  });
});
