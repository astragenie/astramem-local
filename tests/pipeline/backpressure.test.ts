/**
 * tests/pipeline/backpressure.test.ts (stabilization plan P1.4 + P1.5)
 *
 * Pure-function governor tests (injected clock/random, fake timers for the
 * boot ramp) + worker-integration tests proving lanes above the budget skip
 * claiming and retry delays are shaped through the governor.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  createLoadGovernor,
  DEFAULT_SLOW_THRESHOLD_MS,
  DEFAULT_SEVERE_THRESHOLD_MS,
  DEFAULT_RETRY_BUDGET_PER_MIN,
  RETRY_STORM_FLOOR_MS,
} from '../../src/pipeline/backpressure.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('createLoadGovernor — latency staircase', () => {
  it('full budget while embed-heavy EWMA is healthy', () => {
    const g = createLoadGovernor({ maxLanes: 4 });
    for (let i = 0; i < 10; i++) g.recordHandlerRun('distill', 800);
    expect(g.laneBudget()).toBe(4);
    g.stop();
  });

  it('halves the budget past the slow threshold, quarters past severe — never below 1', () => {
    const g = createLoadGovernor({ maxLanes: 4 });
    for (let i = 0; i < 20; i++) g.recordHandlerRun('reembed', DEFAULT_SLOW_THRESHOLD_MS * 3);
    expect(g.laneBudget()).toBe(2);
    for (let i = 0; i < 20; i++) g.recordHandlerRun('reembed', DEFAULT_SEVERE_THRESHOLD_MS * 5);
    expect(g.laneBudget()).toBe(1);

    const g2 = createLoadGovernor({ maxLanes: 2 });
    for (let i = 0; i < 20; i++) g2.recordHandlerRun('distill', 130_000); // the measured incident latency
    expect(g2.laneBudget()).toBe(1); // 2 * 0.25 rounds to 1, floor holds
    g.stop(); g2.stop();
  });

  it('recovers the budget as latency comes back down (EWMA decays)', () => {
    const g = createLoadGovernor({ maxLanes: 4 });
    for (let i = 0; i < 20; i++) g.recordHandlerRun('distill', 60_000);
    expect(g.laneBudget()).toBe(1);
    for (let i = 0; i < 40; i++) g.recordHandlerRun('distill', 500);
    expect(g.laneBudget()).toBe(4);
    g.stop();
  });

  it('non-embed-heavy kinds and garbage durations never move the EWMA', () => {
    const g = createLoadGovernor({ maxLanes: 4 });
    g.recordHandlerRun('cleanup', 500_000);
    g.recordHandlerRun('consolidate', 500_000);
    g.recordHandlerRun('distill', NaN);
    g.recordHandlerRun('distill', -5);
    expect(g.laneBudget()).toBe(4);
    g.stop();
  });
});

describe('createLoadGovernor — boot ramp', () => {
  it('ramps 1 → half → full on the step cadence, then stays at full', () => {
    vi.useFakeTimers();
    const g = createLoadGovernor({ maxLanes: 4, bootRamp: { rampStepMs: 1_000 } });
    expect(g.laneBudget()).toBe(1);
    vi.advanceTimersByTime(1_000);
    expect(g.laneBudget()).toBe(2);
    vi.advanceTimersByTime(1_000);
    expect(g.laneBudget()).toBe(4);
    vi.advanceTimersByTime(60_000);
    expect(g.laneBudget()).toBe(4);
    g.stop();
  });

  it('no bootRamp option = full budget immediately (test/CLI contexts)', () => {
    const g = createLoadGovernor({ maxLanes: 3 });
    expect(g.laneBudget()).toBe(3);
    g.stop();
  });

  it('latency throttle applies during the ramp too (min of the two caps)', () => {
    vi.useFakeTimers();
    const g = createLoadGovernor({ maxLanes: 4, bootRamp: { rampStepMs: 1_000 } });
    for (let i = 0; i < 20; i++) g.recordHandlerRun('distill', 60_000);
    vi.advanceTimersByTime(5_000); // ramp fully done
    expect(g.laneBudget()).toBe(1); // severe latency cap wins over ramp
    g.stop();
  });
});

describe('createLoadGovernor — retry shaping', () => {
  it('applies positive-only jitter: never shrinks the delay', () => {
    const g = createLoadGovernor({ maxLanes: 2, random: () => 0 });
    expect(g.shapeRetryDelay(4_000)).toBe(4_000);
    const gMax = createLoadGovernor({ maxLanes: 2, random: () => 1 });
    expect(gMax.shapeRetryDelay(4_000)).toBe(5_200); // +30%
    g.stop(); gMax.stop();
  });

  it('clamps the floor up to RETRY_STORM_FLOOR_MS once the per-minute retry budget is exceeded', () => {
    let t = 1_000_000;
    const g = createLoadGovernor({ maxLanes: 2, now: () => t, random: () => 0 });
    for (let i = 0; i <= DEFAULT_RETRY_BUDGET_PER_MIN; i++) g.recordRetry();
    expect(g.shapeRetryDelay(2_000)).toBe(RETRY_STORM_FLOOR_MS);
    // A delay already above the floor is untouched (jitter aside).
    expect(g.shapeRetryDelay(90_000)).toBe(90_000);
    // Window slides: a minute later the storm clamp releases.
    t += 61_000;
    expect(g.shapeRetryDelay(2_000)).toBe(2_000);
    g.stop();
  });

  it('garbage delay input degrades to a sane base, never NaN', () => {
    const g = createLoadGovernor({ maxLanes: 2, random: () => 0 });
    expect(g.shapeRetryDelay(NaN)).toBe(1_000);
    expect(g.shapeRetryDelay(-50)).toBe(1_000);
    g.stop();
  });
});
