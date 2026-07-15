/**
 * tests/server/event-loop-lag.test.ts (stabilization plan P1.2)
 *
 * The monitor wraps perf_hooks.monitorEventLoopDelay; tests inject a fake
 * HistogramLike with controlled ns values (same injectable-seam pattern as
 * watchdog-probe's fetchImpl) so no test depends on real loop timing.
 */
import { describe, it, expect, vi } from 'vitest';
import { createEventLoopLagMonitor, type HistogramLike } from '../../src/server/event-loop-lag.js';
import { checkEventLoopLag, P99_ALARM_MS, MAX_ALARM_MS, MIN_WINDOW_AGE_MS } from '../../src/doctor/checks/event-loop-lag.js';

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
  function monitorWith(p99Ms: number, windowAgeMs: number, maxMs = p99Ms * 2) {
    const now = Date.now();
    return {
      snapshot: () => ({ p99Ms, meanMs: p99Ms / 2, maxMs, windowStartedAt: now - windowAgeMs }),
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

  it('RED on a rare-but-severe single stall: max over MAX_ALARM_MS with a healthy p99', async () => {
    // The incident class: one 219s block is a single histogram sample —
    // statistically invisible to p99 over a mature window, but max sees it.
    const result = await checkEventLoopLag(7777, monitorWith(12, 15 * 60_000, MAX_ALARM_MS + 214_000)).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`worst single stall ${MAX_ALARM_MS + 214_000}ms`);
    expect(result.fix).toBeTruthy();
  });

  it('GREEN when max is a normal one-off pause under MAX_ALARM_MS', async () => {
    const result = await checkEventLoopLag(7777, monitorWith(12, 15 * 60_000, 1_200)).run();
    expect(result.ok).toBe(true);
  });

  it('inconclusive (not GREEN) during the cold-start window, even with a huge p99', async () => {
    const result = await checkEventLoopLag(7777, monitorWith(50_000, MIN_WINDOW_AGE_MS - 1_000)).run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });

  it('resets the monitor after each in-process read so the next scheduled read sees a full fresh window', async () => {
    // Review finding (feat/p1-2): a serve.ts wall-clock reset timer with the
    // same period as the doctor schedule phase-aligned with it and wiped the
    // window right before every scheduled read — permanent inconclusive.
    // The check itself owning the reset (read THEN reset) kills that class.
    const mon = monitorWith(12, 15 * 60_000);
    await checkEventLoopLag(7777, mon).run();
    expect(mon.reset).toHaveBeenCalledOnce();

    // Reset happens on the inconclusive path too — the boot tick restarts
    // the window so the second tick is judged on a full window.
    const cold = monitorWith(12, 1_000);
    const result = await checkEventLoopLag(7777, cold).run();
    expect(result.inconclusive).toBe(true);
    expect(cold.reset).toHaveBeenCalledOnce();
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
