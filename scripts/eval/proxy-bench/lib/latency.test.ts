import { describe, it, expect } from 'vitest';
import { summarizeExtended, collectLatencies, computeOverhead } from './latency.js';

describe('summarizeExtended — percentile plumbing', () => {
  it('matches perf/lib/stats.ts summarize() for n/p50/p95/max/mean on a known series', () => {
    // 1..100ms — nearest-rank p50 = 50th value = 50, p95 = 95th value = 95.
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    const s = summarizeExtended(samples);
    expect(s.n).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(s.max).toBe(100);
    expect(s.min).toBe(1);
    expect(s.mean).toBeCloseTo(50.5, 10);
  });

  it('does not mutate the input array (percentile math operates on a sorted copy)', () => {
    const samples = [5, 1, 4, 2, 3];
    summarizeExtended(samples);
    expect(samples).toEqual([5, 1, 4, 2, 3]);
  });

  it('handles an empty series without throwing', () => {
    const s = summarizeExtended([]);
    expect(s.n).toBe(0);
    expect(s.min).toBe(0);
    expect(s.p50).toBe(0);
    expect(s.p99).toBe(0);
  });

  it('handles a single-sample series (p50/p95/p99 all equal that sample)', () => {
    const s = summarizeExtended([7.5]);
    expect(s.n).toBe(1);
    expect(s.min).toBe(7.5);
    expect(s.p50).toBe(7.5);
    expect(s.p95).toBe(7.5);
    expect(s.p99).toBe(7.5);
    expect(s.max).toBe(7.5);
  });

  it('retains the raw samples for JSON output / re-derivation', () => {
    const s = summarizeExtended([3, 1, 2]);
    expect(s.raw).toEqual([3, 1, 2]);
  });
});

describe('collectLatencies — warmup-aware, deterministic timing loop', () => {
  it('discards exactly the warmup prefix and returns `iterations` samples', async () => {
    let calls = 0;
    const samples = await collectLatencies(async () => { calls++; }, { iterations: 5, warmup: 3 });
    expect(calls).toBe(8);
    expect(samples).toHaveLength(5);
  });

  it('with concurrency=1, calls fn strictly sequentially (call N completes before N+1 starts)', async () => {
    const order: number[] = [];
    let active = 0;
    let maxActive = 0;
    await collectLatencies(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    }, { iterations: 5, warmup: 0, concurrency: 1 });
    expect(maxActive).toBe(1);
  });

  it('with concurrency>1, allows overlapping in-flight calls', async () => {
    let active = 0;
    let maxActive = 0;
    await collectLatencies(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 20));
      active--;
    }, { iterations: 10, warmup: 0, concurrency: 4 });
    expect(maxActive).toBeGreaterThan(1);
  });

  it('every returned sample is a finite non-negative number', async () => {
    const samples = await collectLatencies(async () => { /* instant */ }, { iterations: 10, warmup: 0 });
    for (const s of samples) {
      expect(Number.isFinite(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('computeOverhead — proxied minus direct delta', () => {
  it('computes a positive delta when the proxy is slower', () => {
    const direct = summarizeExtended([1, 1, 1, 1, 1]);
    const proxied = summarizeExtended([9, 9, 9, 9, 9]);
    const overhead = computeOverhead(direct, proxied);
    expect(overhead.p50).toBeCloseTo(8, 10);
    expect(overhead.mean).toBeCloseTo(8, 10);
  });

  it('computes a zero delta when both distributions are identical', () => {
    const a = summarizeExtended([2, 4, 6, 8, 10]);
    const b = summarizeExtended([2, 4, 6, 8, 10]);
    const overhead = computeOverhead(a, b);
    expect(overhead.p50).toBe(0);
    expect(overhead.p95).toBe(0);
    expect(overhead.p99).toBe(0);
    expect(overhead.mean).toBe(0);
  });

  it('can be negative if the "proxied" leg happens to be faster than "direct"', () => {
    const direct = summarizeExtended([10, 10, 10]);
    const proxied = summarizeExtended([2, 2, 2]);
    const overhead = computeOverhead(direct, proxied);
    expect(overhead.p50).toBeLessThan(0);
  });
});
