import { describe, it, expect } from 'vitest';
import { mapWithConcurrency, resolveChunkConcurrency } from '../../src/distill/concurrency.js';
import { defaultConfig } from '../../src/config/config.js';

/** Controllable promise for orchestrating exact interleaving in tests. */
function createDeferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Flush pending microtasks so synchronously-scheduled `.then`/`await` chains settle. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('mapWithConcurrency', () => {
  it('limit=1 processes items strictly in order, one at a time (byte-for-byte sequential)', async () => {
    const dispatched: number[] = [];
    const results = await mapWithConcurrency([10, 20, 30], 1, async (item, idx) => {
      dispatched.push(idx);
      return item * 2;
    });

    expect(dispatched).toEqual([0, 1, 2]);
    expect(results).toEqual([20, 40, 60]);
  });

  it('limit=1 stops at the first error — later items are never dispatched', async () => {
    const dispatched: number[] = [];
    const boom = new Error('boom at index 1');

    await expect(
      mapWithConcurrency([0, 1, 2, 3], 1, async (item, idx) => {
        dispatched.push(idx);
        if (idx === 1) throw boom;
        return item;
      }),
    ).rejects.toBe(boom);

    expect(dispatched).toEqual([0, 1]);
  });

  it('preserves result order by input index regardless of completion order', async () => {
    const deferreds = [createDeferred<string>(), createDeferred<string>(), createDeferred<string>()];
    const p = mapWithConcurrency([0, 1, 2], 3, async (_item, idx) => deferreds[idx]!.promise);

    // Resolve out of order: last item first, first item last.
    deferreds[2]!.resolve('c');
    deferreds[0]!.resolve('a');
    deferreds[1]!.resolve('b');

    const results = await p;
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('respects the concurrency ceiling — never more than `limit` calls in flight', async () => {
    const items = [0, 1, 2, 3, 4];
    const deferreds = items.map(() => createDeferred<number>());
    const dispatched: number[] = [];

    const p = mapWithConcurrency(items, 3, async (_item, idx) => {
      dispatched.push(idx);
      return deferreds[idx]!.promise;
    });

    await flush();
    // Exactly 3 workers dispatched, no more — the 4th/5th item must wait.
    expect(dispatched).toEqual([0, 1, 2]);

    // Resolving one in-flight call frees a worker slot for the next item.
    deferreds[0]!.resolve(0);
    await flush();
    expect(dispatched).toEqual([0, 1, 2, 3]);

    deferreds[1]!.resolve(1);
    await flush();
    expect(dispatched).toEqual([0, 1, 2, 3, 4]);

    deferreds[2]!.resolve(2);
    deferreds[3]!.resolve(3);
    deferreds[4]!.resolve(4);
    const results = await p;
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('budget-stop: once one dispatched call rejects, no further NEW items are dispatched (in-flight calls still settle)', async () => {
    class BudgetLikeError extends Error {}
    const items = [0, 1, 2, 3, 4];
    const deferreds = items.map(() => createDeferred<number>());
    const dispatched: number[] = [];
    const budgetError = new BudgetLikeError('cap hit');

    const p = mapWithConcurrency(items, 2, async (_item, idx) => {
      dispatched.push(idx);
      if (idx === 1) throw budgetError;
      return deferreds[idx]!.promise;
    });
    // Swallow the eventual rejection here so it isn't reported as unhandled
    // before the assertions below run; the real assertion happens via the
    // `rejects` expectation further down against the same promise.
    p.catch(() => {});

    await flush();
    // Worker A got item 0 (now parked awaiting deferred[0]); worker B got
    // item 1, which threw synchronously — dispatch must stop there.
    expect(dispatched).toEqual([0, 1]);

    // Let the still in-flight item 0 settle — this must NOT unlock items 2-4.
    deferreds[0]!.resolve(0);
    await flush();
    expect(dispatched).toEqual([0, 1]);

    await expect(p).rejects.toBe(budgetError);
    expect(dispatched).toEqual([0, 1]);
  });

  it('propagates the exact error instance — not an AggregateError or wrapper', async () => {
    class BudgetLikeError extends Error {
      constructor(public readonly cap: number) { super('over cap'); }
    }
    const err = new BudgetLikeError(10);

    let caught: unknown;
    try {
      await mapWithConcurrency([0, 1, 2], 2, async (_item, idx) => {
        if (idx === 0) throw err;
        return idx;
      });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBe(err);
    expect((caught as BudgetLikeError).cap).toBe(10);
  });

  it('empty input resolves to an empty array without calling fn', async () => {
    let calls = 0;
    const results = await mapWithConcurrency([], 4, async () => { calls++; return 0; });
    expect(results).toEqual([]);
    expect(calls).toBe(0);
  });

  it('limit greater than item count still processes everything exactly once', async () => {
    const dispatched: number[] = [];
    const results = await mapWithConcurrency(['a', 'b'], 10, async (item, idx) => {
      dispatched.push(idx);
      return item.toUpperCase();
    });
    expect(dispatched.sort()).toEqual([0, 1]);
    expect(results).toEqual(['A', 'B']);
  });
});

describe('resolveChunkConcurrency', () => {
  it('defaults to 2 (default config, matching OLLAMA_NUM_PARALLEL=2)', () => {
    expect(resolveChunkConcurrency(defaultConfig())).toBe(2);
  });

  it('passes through values within [1, 8]', () => {
    const cfg = { ...defaultConfig(), distill: { ...defaultConfig().distill, chunkConcurrency: 5 } };
    expect(resolveChunkConcurrency(cfg)).toBe(5);
  });

  it('clamps values above 8 down to 8', () => {
    const cfg = { ...defaultConfig(), distill: { ...defaultConfig().distill, chunkConcurrency: 99 } };
    expect(resolveChunkConcurrency(cfg)).toBe(8);
  });

  it('clamps values below 1 (zero, negative) up to 1 — the safety valve for byte-identical sequential behavior', () => {
    expect(resolveChunkConcurrency({ ...defaultConfig(), distill: { ...defaultConfig().distill, chunkConcurrency: 0 } })).toBe(1);
    expect(resolveChunkConcurrency({ ...defaultConfig(), distill: { ...defaultConfig().distill, chunkConcurrency: -3 } })).toBe(1);
  });

  it('falls back to 1 for non-finite / non-numeric values rather than throwing', () => {
    expect(resolveChunkConcurrency({ ...defaultConfig(), distill: { ...defaultConfig().distill, chunkConcurrency: NaN } })).toBe(1);
    expect(resolveChunkConcurrency({
      ...defaultConfig(),
      distill: { ...defaultConfig().distill, chunkConcurrency: 'two' as unknown as number },
    })).toBe(1);
  });

  it('truncates fractional values', () => {
    expect(resolveChunkConcurrency({ ...defaultConfig(), distill: { ...defaultConfig().distill, chunkConcurrency: 3.9 } })).toBe(3);
  });

  it('setting chunkConcurrency to 1 is the documented safety valve for exact sequential behavior', () => {
    const cfg = { ...defaultConfig(), distill: { ...defaultConfig().distill, chunkConcurrency: 1 } };
    expect(resolveChunkConcurrency(cfg)).toBe(1);
  });
});
