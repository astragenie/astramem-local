import { describe, it, expect, vi } from 'vitest';
import {
  gatekeeperBatch,
  runGatekeeperSweep,
  GatekeeperRunTracker,
  GATEKEEPER_MARKER,
} from '../../src/distill/gatekeeper.js';
import type { LLMProvider, ChatMsg, ChatOpts } from '../../src/contracts/llm.js';

function makeProvider(
  responder: (messages: ChatMsg[], opts?: ChatOpts) => string,
): LLMProvider {
  return {
    name: 'ollama',
    model: 'test-gatekeeper-model',
    async chat(messages, opts) {
      return { text: responder(messages, opts), usage: { in: 1, out: 1, usd: 0 } };
    },
    async health() {
      return { ok: true, model: 'test-gatekeeper-model', latency_ms: 0 };
    },
  };
}

function makeThrowingProvider(message: string): LLMProvider {
  return {
    name: 'ollama',
    model: 'test-gatekeeper-model',
    async chat() {
      throw new Error(message);
    },
    async health() {
      return { ok: true, model: 'test-gatekeeper-model', latency_ms: 0 };
    },
  };
}

describe('gatekeeperBatch', () => {
  it('returns an empty Map for an empty chunk list without calling the provider', async () => {
    let called = false;
    const provider = makeProvider(() => {
      called = true;
      return JSON.stringify({ verdicts: [] });
    });
    const result = await gatekeeperBatch(provider, []);
    expect(result.size).toBe(0);
    expect(called).toBe(false);
  });

  it('parses a well-formed batch response into a Map keyed by index', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 3, verdict: 'skip', confidence: 0.9 },
          { index: 7, verdict: 'keep', confidence: 0.5 },
        ],
      }),
    );
    const result = await gatekeeperBatch(provider, [
      { index: 3, text: 'hey thanks!' },
      { index: 7, text: 'the team chose PostgreSQL for ACID guarantees' },
    ]);
    expect(result.get(3)).toEqual({ index: 3, verdict: 'skip', confidence: 0.9 });
    expect(result.get(7)).toEqual({ index: 7, verdict: 'keep', confidence: 0.5 });
    expect(result.size).toBe(2);
  });

  it('embeds the stable marker in the system prompt so mock providers can route on it', async () => {
    let seenSystem = '';
    const provider = makeProvider((messages) => {
      seenSystem = messages.find((m) => m.role === 'system')?.content ?? '';
      return JSON.stringify({ verdicts: [] });
    });
    await gatekeeperBatch(provider, [{ index: 0, text: 'x' }]);
    expect(seenSystem).toContain(GATEKEEPER_MARKER);
  });

  it('requests json + a schema hint', async () => {
    let seenOpts: ChatOpts | undefined;
    const provider = makeProvider((_messages, opts) => {
      seenOpts = opts;
      return JSON.stringify({ verdicts: [] });
    });
    await gatekeeperBatch(provider, [{ index: 0, text: 'x' }]);
    expect(seenOpts?.json).toBe(true);
    expect(seenOpts?.jsonSchema).toBeTruthy();
  });

  it('fails open (empty Map) when the response is not valid JSON at all, logging a warning — never throws', async () => {
    const log = vi.fn();
    const provider = makeProvider(() => 'not json at all');
    const result = await gatekeeperBatch(provider, [{ index: 0, text: 'x' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('batch call failed'));
  });

  it("fails open (empty Map) when the response is valid JSON but the wrong shape (no 'verdicts' array), logging a warning", async () => {
    const log = vi.fn();
    const provider = makeProvider(() => JSON.stringify({ foo: 'bar' }));
    const result = await gatekeeperBatch(provider, [{ index: 0, text: 'x' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('unparsable'));
  });

  it('fails open (empty Map) on a thrown/rejected chat() call, logging the provider error — never throws', async () => {
    const log = vi.fn();
    const provider = makeThrowingProvider('connection refused');
    const result = await gatekeeperBatch(provider, [{ index: 0, text: 'x' }], { log });
    expect(result.size).toBe(0);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
  });

  it('a single malformed verdict entry is dropped without discarding the rest of the batch', async () => {
    const provider = makeProvider(() =>
      JSON.stringify({
        verdicts: [
          { index: 0, verdict: 'not-a-real-label', confidence: 0.9 }, // invalid enum
          { index: 1, verdict: 'keep', confidence: 0.5 }, // valid
          { index: 2, verdict: 'skip', confidence: 2.0 }, // confidence out of [0,1]
        ],
      }),
    );
    const result = await gatekeeperBatch(provider, [
      { index: 0, text: 'a' },
      { index: 1, text: 'b' },
      { index: 2, text: 'c' },
    ]);
    expect(result.has(0)).toBe(false);
    expect(result.get(1)).toEqual({ index: 1, verdict: 'keep', confidence: 0.5 });
    expect(result.has(2)).toBe(false);
  });
});

describe('GatekeeperRunTracker', () => {
  it('shouldStop() is false until maxPerRun calls are recorded', () => {
    const tracker = new GatekeeperRunTracker({ maxPerRun: 2, maxWallClockMs: 60_000 }, () => {});
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
    const tracker = new GatekeeperRunTracker({ maxPerRun: 1000, maxWallClockMs: 0 }, log);
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.shouldStop()).toBe(true);
    expect(tracker.state().wallClockCapReached).toBe(true);
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]![0]).toContain('wall-clock');
  });
});

describe('runGatekeeperSweep', () => {
  it('returns an empty result and makes no call when no provider is supplied (no-op convention)', async () => {
    const result = await runGatekeeperSweep(
      [{ index: 0, text: 'hello' }],
      undefined,
      { batchSize: 20, caps: { maxPerRun: 200, maxWallClockMs: 300_000 } },
    );
    expect(result.verdicts.size).toBe(0);
    expect(result.chunksEvaluated).toBe(0);
  });

  it('returns an empty result for an empty chunk list', async () => {
    const provider = makeProvider(() => JSON.stringify({ verdicts: [] }));
    const result = await runGatekeeperSweep([], provider, { batchSize: 20, caps: { maxPerRun: 200, maxWallClockMs: 300_000 } });
    expect(result.verdicts.size).toBe(0);
    expect(result.chunksEvaluated).toBe(0);
  });

  it('batches over the chunk list, respecting batchSize', async () => {
    const seenBatchSizes: number[] = [];
    const provider = makeProvider((messages) => {
      const user = messages.find((m) => m.role === 'user')?.content ?? '';
      seenBatchSizes.push(user.split('\n').length);
      return JSON.stringify({ verdicts: [] });
    });
    const chunks = Array.from({ length: 5 }, (_, i) => ({ index: i, text: `chunk ${i}` }));
    await runGatekeeperSweep(chunks, provider, { batchSize: 2, caps: { maxPerRun: 200, maxWallClockMs: 300_000 } });
    expect(seenBatchSizes).toEqual([2, 2, 1]);
  });

  it('counts every attempted chunk toward chunksEvaluated even when the provider fails open', async () => {
    const provider = makeThrowingProvider('down');
    const chunks = Array.from({ length: 3 }, (_, i) => ({ index: i, text: `chunk ${i}` }));
    const result = await runGatekeeperSweep(chunks, provider, { batchSize: 20, caps: { maxPerRun: 200, maxWallClockMs: 300_000 }, log: () => {} });
    expect(result.chunksEvaluated).toBe(3);
    expect(result.verdicts.size).toBe(0);
  });

  it('stops early once maxPerRun trips, leaving remaining chunks un-gated', async () => {
    let calls = 0;
    const provider = makeProvider(() => {
      calls++;
      return JSON.stringify({ verdicts: [] });
    });
    const chunks = Array.from({ length: 10 }, (_, i) => ({ index: i, text: `chunk ${i}` }));
    const result = await runGatekeeperSweep(chunks, provider, { batchSize: 1, caps: { maxPerRun: 3, maxWallClockMs: 300_000 }, log: () => {} });
    expect(calls).toBe(3);
    expect(result.chunksEvaluated).toBe(3);
  });
});
