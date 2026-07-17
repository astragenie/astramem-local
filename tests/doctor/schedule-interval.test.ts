/**
 * tests/doctor/schedule-interval.test.ts
 *
 * Split out of tests/doctor/schedule.test.ts (2026-07-17) — the boot-pass /
 * recurring-tick / stop() behavior of `startFrequentDoctorSchedule` used to
 * be proven there with REAL timers driving the REAL check registry (~50+
 * checks, run sequentially by runChecks() in src/doctor/runner.ts — genuine
 * SQLite reads, filesystem stats, a loopback fetch). Under parallel CI load
 * a single real tick can take longer than the test's short interval, so
 * consecutive setInterval ticks overlap and resolve in an order/timing that
 * depends on machine load rather than on the schedule logic itself — the
 * observed symptom was off-by-one tick counts ("expected 6 to be 5") or a
 * flat 5000ms timeout, always passing in isolation.
 *
 * That old test's own comment explained why it avoided vitest fake timers in
 * the first place: several real checks do genuine async I/O (dynamic
 * imports, a real loopback fetch with its own real setTimeout-based abort)
 * that fake-timer virtual-time advancement does not reliably wait out. That
 * reasoning is still correct for the REAL check registry — but the thing
 * this test actually needs to prove is the SCHEDULE's timer logic (fires on
 * boot, fires again every interval, stops firing after stop()), not the
 * real checks' own behavior (that's covered by schedule.test.ts's other
 * tests, which call runFrequentDoctorChecks/runFullDoctorChecks directly
 * with no wall-clock race). So here the check registry itself is mocked
 * down to a single near-instant stub check, which makes fake timers fully
 * safe to use: with no real I/O anywhere in the tick, vi.advanceTimersByTimeAsync
 * can drive the interval deterministically and assert exact tick counts,
 * independent of CPU/machine load.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Check } from '../../src/doctor/types.js';
import type { DoctorCheckOpts } from '../../src/doctor/checks.js';
import { startFrequentDoctorSchedule, type DoctorScheduleResult } from '../../src/doctor/schedule.js';

// vi.mock calls are hoisted above these imports by vitest's transform, so
// schedule.ts's internal `getChecks` binds to this stub rather than the real
// ~50-check registry — see the file header comment for why.
vi.mock('../../src/doctor/checks.js', () => {
  const stubCheck: Check = {
    name: 'stub cheap check',
    tier: 'cheap',
    run: async () => ({ ok: true, message: 'stub' }),
  };
  return {
    getChecks: (): Check[] => [stubCheck],
    crashLoopStreakLength: (): number => 0,
    CRASH_LOOP_THRESHOLD: 3,
  };
});

describe('doctor scheduling — interval firing (deterministic, fake timers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires an immediate boot pass, then fires again on its own after each interval elapses — no external trigger', async () => {
    const opts: DoctorCheckOpts = { dataDir: undefined, encryptionEnabled: false, port: 39777 };
    const seen: DoctorScheduleResult[] = [];
    const stop = startFrequentDoctorSchedule(opts, (r) => seen.push(r), 40);

    try {
      // Boot pass — tick() runs synchronously inside startFrequentDoctorSchedule,
      // before the interval is even registered. Flushing the fake-timer queue
      // once also flushes the pending microtasks from that in-flight promise.
      await vi.advanceTimersByTimeAsync(0);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.tier).toBe('frequent');

      // Purely time passing (virtual), no external trigger — exact counts,
      // no wall-clock race.
      await vi.advanceTimersByTimeAsync(40);
      expect(seen).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(40);
      expect(seen).toHaveLength(3);
    } finally {
      stop();
    }
  });

  it('stop() clears the interval — no further ticks fire once stopped', async () => {
    const opts: DoctorCheckOpts = { dataDir: undefined, encryptionEnabled: false, port: 39777 };
    const seen: DoctorScheduleResult[] = [];
    const stop = startFrequentDoctorSchedule(opts, (r) => seen.push(r), 40);

    await vi.advanceTimersByTimeAsync(0); // boot pass
    await vi.advanceTimersByTimeAsync(80); // two more ticks
    expect(seen).toHaveLength(3);

    stop();
    await vi.advanceTimersByTimeAsync(10 * 40); // would be 10 more ticks if still running
    expect(seen).toHaveLength(3); // stopped — exact count, no off-by-one
  });
});
