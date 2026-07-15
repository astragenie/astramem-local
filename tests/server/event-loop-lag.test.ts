/**
 * tests/server/event-loop-lag.test.ts (stabilization plan P1.2)
 *
 * The monitor wraps perf_hooks.monitorEventLoopDelay; tests inject a fake
 * HistogramLike with controlled ns values (same injectable-seam pattern as
 * watchdog-probe's fetchImpl) so no test depends on real loop timing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEventLoopLagMonitor, type HistogramLike } from '../../src/server/event-loop-lag.js';
import { checkEventLoopLag, P99_ALARM_MS, MIN_WINDOW_AGE_MS } from '../../src/doctor/checks/event-loop-lag.js';

const NS = 1e6; // 1ms in ns

function makeFakeHistogram(p99Ns: number, meanNs = p99Ns / 2, maxNs = p99Ns * 2): HistogramLike {
  return {
    enable: vi.fn(),
    disable: vi.fn(),
    reset: vi.fn(),
    percentile: vi.fn(() => p99Ns),
    mean: meanNs,
    max: maxNs,
  };
}

describe('createEventLoopLagMonitor', () => {
  it('enables the histogram on creation and converts ns to ms in snapshots', () => {
    const h = makeFakeHistogram(1500 * NS, 20 * NS, 3000 * NS);
    let t = 1_000_000;
    const mon = createEventLoopLagMonitor(h, () => t);

    expect(h.enable).toHaveBeenCalledOnce();
    const snap = mon.snapshot();
    expect(snap.p99Ms).toBe(1500);
    expect(snap.meanMs).toBe(20);
    expect(snap.maxMs).toBe(3000);
    expect(snap.windowStartedAt).toBe(1_000_000);

    t = 2_000_000;
    mon.reset();
    expect(h.reset).toHaveBeenCalledOnce();
    expect(mon.snapshot().windowStartedAt).toBe(2_000_000);
  });

  it('reports 0 (not NaN) for an empty histogram', () => {
    const h = makeFakeHistogram(NaN, NaN, NaN);
    const snap = createEventLoopLagMonitor(h, () => 0).snapshot();
    expect(snap.p99Ms).toBe(0);
    expect(snap.meanMs).toBe(0);
    expect(snap.maxMs).toBe(0);
  });

  it('disable() forwards to the histogram', () => {
    const h = makeFakeHistogram(0);
    createEventLoopLagMonitor(h, () => 0).disable();
    expect(h.disable).toHaveBeenCalledOnce();
  });
});

describe('checkEventLoopLag (in-process monitor path)', () => {
  function monitorWith(p99Ms: number, windowAgeMs: number) {
    const now = Date.now();
    return {
      snapshot: () => ({ p99Ms, meanMs: p99Ms / 2, maxMs: p99Ms * 2, windowStartedAt: now - windowAgeMs }),
      reset: vi.fn(),
      disable: vi.fn(),
    };
  }

  it('GREEN with numbers when p99 is under the alarm and the window is mature', async () => {
    const result = await checkEventLoopLag(7777, monitorWith(12, 5 * 60_000)).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBeFalsy();
    expect(result.message).toContain('p99 12ms');
  });

  it('RED with numbers when p99 exceeds the alarm', async () => {
    const result = await checkEventLoopLag(7777, monitorWith(P99_ALARM_MS + 500, 5 * 60_000)).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`p99 ${P99_ALARM_MS + 500}ms`);
    expect(result.fix).toBeTruthy();
  });

  it('inconclusive (not GREEN) during the cold-start window, even with a huge p99', async () => {
    const result = await checkEventLoopLag(7777, monitorWith(50_000, MIN_WINDOW_AGE_MS - 1_000)).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });
});

describe('checkEventLoopLag (out-of-process /health path)', () => {
  it('reads the event_loop block off /health when no monitor is injected', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      event_loop: { p99Ms: 8, meanMs: 2, maxMs: 40, windowStartedAt: Date.now() - 10 * 60_000 },
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await checkEventLoopLag(7777, undefined, fetchImpl).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('via /health');
    expect(result.message).toContain('p99 8ms');
  });

  it('inconclusive when the daemon is unreachable — never a false GREEN', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const result = await checkEventLoopLag(7777, undefined, fetchImpl).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });

  it('inconclusive when /health has no event_loop block (older build)', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as unknown as typeof fetch;
    const result = await checkEventLoopLag(7777, undefined, fetchImpl).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message).toContain('no event_loop block');
  });
});
