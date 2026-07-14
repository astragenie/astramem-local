/**
 * Answering concurrently must produce EXACTLY what answering serially produced.
 *
 * `answer.mts` is the deliberately-fixed cheap answerer: changing its prompt,
 * its deployment, or `k` invalidates every benchmark number ever recorded with
 * it. Adding concurrency is only legitimate because it changes NONE of those —
 * it changes the *schedule*, not the *work*.
 *
 * This file pins that claim. It is the difference between "a wall-clock
 * optimisation" and "a silent benchmark rewrite", and it is the only reason the
 * change is safe to make at all.
 *
 * (Why it mattered: the full suite is 1986 questions. Serially, at ~1.5-2s each,
 * that is ~55 minutes of pure waiting. An eval that takes an hour is an eval
 * people stop running — which is how a "45.4" ends up quoted from a single
 * conversation, n=199, instead of the full set.)
 */
import { describe, it, expect } from 'vitest';

/** Local copy of the bounded-concurrency mapper under test (same code as answer.mts). */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]!, i);
    }
  });
  await Promise.all(runners);
  return results;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

describe('mapWithConcurrency — the schedule changes, the output does not', () => {
  it('preserves INPUT order even when work completes out of order', async () => {
    const items = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    // Deliberately invert the durations: later items finish FIRST. If the
    // implementation appended on completion (the obvious bug), the output would
    // come back reversed.
    const out = await mapWithConcurrency(items, 4, async (n) => {
      await sleep((items.length - n) * 5);
      return `answer-${n}`;
    });
    expect(out).toEqual(items.map(n => `answer-${n}`));
  });

  it('is byte-identical to a serial run over the same inputs', async () => {
    const items = Array.from({ length: 50 }, (_, i) => i);
    const work = async (n: number) => {
      await sleep(n % 3);
      return { id: n, hypothesis: `h${n}` };
    };

    const serial: Array<{ id: number; hypothesis: string }> = [];
    for (const n of items) serial.push(await work(n));

    const concurrent = await mapWithConcurrency(items, 8, work);

    expect(JSON.stringify(concurrent)).toBe(JSON.stringify(serial));
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(Array.from({ length: 40 }, (_, i) => i), 6, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(3);
      inFlight--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1); // ...and it IS actually running in parallel
  });

  it('concurrency 1 degrades to exactly the old serial behaviour', async () => {
    const order: number[] = [];
    await mapWithConcurrency([0, 1, 2, 3], 1, async (n) => {
      order.push(n);
      await sleep(2);
      return n;
    });
    expect(order).toEqual([0, 1, 2, 3]); // strictly one at a time, in order
  });

  it('handles an empty work list without spawning runners', async () => {
    const out = await mapWithConcurrency([], 8, async () => 'never');
    expect(out).toEqual([]);
  });

  it('a limit larger than the work list does not over-spawn', async () => {
    let peak = 0;
    let inFlight = 0;
    await mapWithConcurrency([1, 2], 16, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(1);
      inFlight--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
