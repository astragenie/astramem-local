// FEAT-549: unit tests for the batched dup-judge module — mirrors
// tests/distill/atom-triage.test.ts (batched-call shape) and
// tests/consolidate/contradiction-judge-onfallback.test.ts (fail-open
// posture) exactly. No real LLM/network involved anywhere in this file.

import { describe, it, expect, vi } from 'vitest';
import {
  dupJudgeBatch,
  DupJudgeRunTracker,
  DUP_JUDGE_MARKER,
} from '../../src/consolidate/dup-judge.js';
import type { LLMProvider, ChatMsg, ChatOpts } from '../../src/contracts/llm.js';

function makeProvider(
  responder: (messages: ChatMsg[], opts?: ChatOpts) => string,
): LLMProvider {
  return {
    name: 'ollama',
    model: 'test-dup-judge-model',
    async chat(messages, opts) {
      return { text: responder(messages, opts), usage: { in: 1, out: 1, usd: 0 } };
    },
    async health() {
      return { ok: true, model: 'test-dup-judge-model', latency_ms: 0 };
    },
  };
}

function makeThrowingProvider(message: string): LLMProvider {
  return {
    name: 'ollama',
    model: 'test-dup-judge-model',
    async chat() {
      throw new Error(message);
    },
    async health() {
      return { ok: true, model: 'test-dup-judge-model', latency_ms: 0 };
    },
  };
}

describe('dupJudgeBatch', () => {
  it('returns an empty Map for an empty pair list without calling the provider', async () => {
    let called = false;
    const provider = makeProvider(() => {
      called = true;
      return JSON.stringify({ verdicts: [] });
    });
    const result = await dupJudgeBatch(provider, []);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('parses a well-formed batch response into a Map keyed by index', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'same-fact-merge', confidence: 0.95 },
          { index: 1, verdict: 'distinct-keep-separate', confidence: 0.9 },
        ],
      }),
    );
    const result = await dupJudgeBatch(provider, [
      { index: 0, winnerText: 'Port 7777 is the default.', loserText: 'The default port is 7777.' },
      { index: 1, winnerText: 'Compliance with Colorado AI regulations is expensive.', loserText: 'Compliance with EU AI regulations is expensive.' },
    ]);
    expect(result.get(0)).toEqual({ index: 0, verdict: 'same-fact-merge', confidence: 0.95 });
    expect(result.get(1)).toEqual({ index: 1, verdict: 'distinct-keep-separate', confidence: 0.9 });
    expect(result.size).toBe(2);
  });

  it('embeds the stable marker in the system prompt so mock providers can route on it', async () => {
    let seenSystem = '';
    const provider = makeProvider((messages) => {
      seenSystem = messages.find((m) => m.role === 'system')?.content ?? '';
      return JSON.stringify({ verdicts: [] });
    });
    await dupJudgeBatch(provider, [{ index: 0, winnerText: 'a', loserText: 'b' }]);
    expect(seenSystem).toContain(DUP_JUDGE_MARKER);
  });

  it('requests json + a schema hint', async () => {
    let seenOpts: ChatOpts | undefined;
    const provider = makeProvider((_messages, opts) => {
      seenOpts = opts;
      return JSON.stringify({ verdicts: [] });
    });
    await dupJudgeBatch(provider, [{ index: 0, winnerText: 'a', loserText: 'b' }]);
    expect(seenOpts?.json).toBe(true);
    expect(seenOpts?.jsonSchema).toBeTruthy();
    expect(seenOpts?.temperature).toBe(0);
  });

  // AC-1's fail-open contract: a parse failure or thrown/rejected chat()
  // call must resolve to an EMPTY Map, never throw — the caller
  // (consolidate.ts's dup-judge sweep) treats a missing verdict as "leave
  // pending", which is exactly today's pre-FEAT-549 behavior.
  it('fails open (empty Map) when the response is not valid JSON at all, logging a warning — never throws', async () => {
    const log = vi.fn();
    const provider = makeProvider(() => 'not json at all');
    const result = await dupJudgeBatch(provider, [{ index: 0, winnerText: 'a', loserText: 'b' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('batch call failed'));
  });

  it("fails open (empty Map) when the response is valid JSON but the wrong shape (no 'verdicts' array), logging a warning", async () => {
    const log = vi.fn();
    const provider = makeProvider(() => JSON.stringify({ foo: 'bar' }));
    const result = await dupJudgeBatch(provider, [{ index: 0, winnerText: 'a', loserText: 'b' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unparsable'));
  });

  it('fails open (empty Map) on a thrown/rejected chat() call, logging the provider error — never throws', async () => {
    const log = vi.fn();
    const provider = makeThrowingProvider('judge provider unreachable (test)');
    const result = await dupJudgeBatch(provider, [{ index: 0, winnerText: 'a', loserText: 'b' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('judge provider unreachable'));
  });

  it('a single malformed verdict entry is dropped without discarding the rest of the batch', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'not-a-real-label', confidence: 0.9 }, // invalid enum
          { index: 1, verdict: 'same-fact-merge', confidence: 0.9 }, // valid
          { index: 2, verdict: 'distinct-keep-separate', confidence: 2.0 }, // confidence out of [0,1]
        ],
      }),
    );
    const result = await dupJudgeBatch(provider, [
      { index: 0, winnerText: 'a', loserText: 'b' },
      { index: 1, winnerText: 'c', loserText: 'd' },
      { index: 2, winnerText: 'e', loserText: 'f' },
    ]);
    expect(result.has(0)).toBe(false);
    expect(result.get(1)).toEqual({ index: 1, verdict: 'same-fact-merge', confidence: 0.9 });
    expect(result.has(2)).toBe(false);
  });
});

describe('DupJudgeRunTracker', () => {
  it('shouldStop() is false until maxPerRun calls are recorded', () => {
    const tracker = new DupJudgeRunTracker({ maxPerRun: 2, maxWallClockMs: 60_000 }, () => {});
    expect(tracker.shouldStop()).toBe(false);
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(false);
    tracker.recordCall();
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.state().capReached).toBe(true);
    expect(tracker.state().wallClockCapReached).toBe(false);
  });

  it('shouldStop() trips on wall-clock elapsed, logged exactly once', () => {
    const log = vi.fn();
    const tracker = new DupJudgeRunTracker({ maxPerRun: 1000, maxWallClockMs: 0 }, log);
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.state().wallClockCapReached).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('wall-clock');
  });
});
