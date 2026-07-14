/**
 * tests/doctor/memory-sentinel-check.test.ts
 *
 * FEAT-494: least-squares RSS growth sentinel. Every case below drives the
 * check via `samples` (a direct series override — see MemorySentinelOpts in
 * src/doctor/checks/memory-sentinel.ts) so the fit is exercised
 * deterministically without waiting real hours or touching the real
 * process/module-level ring. The handful of ring-specific cases at the
 * bottom cover the recording path itself and reset the module-level ring
 * before and after so they can't leak state into other test files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  checkMemorySentinel,
  __resetMemorySentinelRingForTests,
  type MemorySample,
} from '../../src/doctor/checks/memory-sentinel.js';

const MIB = 1024 * 1024;
const MIN15 = 15 * 60 * 1000;

/** Builds `count` samples spaced `stepMs` apart starting at uptimeMs 0, with
 *  rssBytes = base + growth(i). Default 21 samples * 15min = 5h span, well
 *  past the default 30min warmup and 3h min-window floors. */
function series(count: number, growth: (i: number) => number, stepMs = MIN15, baseMb = 200): MemorySample[] {
  return Array.from({ length: count }, (_, i) => ({
    uptimeMs: i * stepMs,
    rssBytes: (baseMb + growth(i)) * MIB,
  }));
}

describe('checkMemorySentinel (FEAT-494)', () => {
  it('ok: flat series never triggers a warning', async () => {
    const samples = series(21, () => 0);
    const result = await checkMemorySentinel({ samples }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no sustained growth');
  });

  it('ok: spiky-but-flat series (bounded oscillation, no net trend) never triggers a warning', async () => {
    const samples = series(21, (i) => (i % 2 === 0 ? 8 : -8));
    const result = await checkMemorySentinel({ samples }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no sustained growth');
  });

  it('warn: genuinely growing series trips all thresholds together', async () => {
    // +10 MB per 15-min sample = 40 MB/h, well past the 10 MiB/h default,
    // over a clean line (r2 ~= 1.0), ending at 400 MB (past the 150 MiB floor).
    const samples = series(21, (i) => i * 10);
    const result = await checkMemorySentinel({ samples }).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('sustained linear RSS growth');
    expect(result.message).toMatch(/r²=(0\.9\d|1\.00)/);
    expect(result.fix).toBeDefined();
  });

  it('ok: not enough post-warmup samples yet', async () => {
    const samples = series(3, (i) => i * 10); // all within/near warmup, too few post-warmup points
    const result = await checkMemorySentinel({ samples }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough post-warmup samples yet');
  });

  it('ok: post-warmup window too short even with enough samples', async () => {
    // 10 samples 1 minute apart starting after warmup — plenty of samples,
    // but the whole post-warmup window spans well under minWindowHours.
    const samples = [
      { uptimeMs: 0, rssBytes: 200 * MIB },
      ...Array.from({ length: 10 }, (_, i) => ({
        uptimeMs: MEMORY_SENTINEL_WARMUP_MS_FOR_TEST + i * 60_000,
        rssBytes: (200 + i * 10) * MIB,
      })),
    ];
    const result = await checkMemorySentinel({ samples }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('window too short yet');
  });

  it('excludes warmup-window samples from the fit — a warmup-only spike does not warn once things go flat after', async () => {
    const warmupSpike = [
      { uptimeMs: 0, rssBytes: 100 * MIB },
      { uptimeMs: 5 * 60_000, rssBytes: 300 * MIB }, // huge jump, but inside the 30min warmup window
    ];
    const flatAfter = series(21, () => 0, MIN15, 300).map((s) => ({
      ...s,
      uptimeMs: s.uptimeMs + MEMORY_SENTINEL_WARMUP_MS_FOR_TEST,
    }));
    const result = await checkMemorySentinel({ samples: [...warmupSpike, ...flatAfter] }).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no sustained growth');
  });

  it('config-tunable thresholds: a moderate growth series that would pass at defaults warns when thresholds are lowered', async () => {
    // +1 MB per 15-min sample = 4 MB/h — well under the 10 MiB/h default, so
    // this must NOT warn at defaults...
    const samples = series(21, (i) => i * 1);
    const atDefaults = await checkMemorySentinel({ samples }).run();
    expect(atDefaults.ok).toBe(true);

    // ...but must warn once the caller supplies lower, still-documented
    // thresholds appropriate to a more sensitive deployment.
    const tightened = await checkMemorySentinel({
      samples,
      slopeThresholdBytesPerHour: 1 * MIB,
      minFittedGrowthBytes: 5 * MIB,
      minAbsoluteRssBytes: 100 * MIB,
      minR2: 0.5,
    }).run();
    expect(tightened.ok).toBe(false);
  });

  it('never warns below the minAbsoluteRssBytes floor even with a clean, fast-growing fit', async () => {
    // Same shape/slope as the "warn" case above but scaled down to a tiny
    // base RSS — must stay green because the daemon isn't carrying enough
    // resident memory yet for the trend to matter.
    const samples = series(21, (i) => i * 0.1, MIN15, 5); // 5 MB -> 7 MB over the window
    const result = await checkMemorySentinel({ samples }).run();
    expect(result.ok).toBe(true);
  });
});

// Re-declared locally (not imported) so this test file pins its OWN
// expectation of the default warmup value independent of the module's
// internal default — if the module's default ever changes, this constant
// must be updated deliberately, not silently follow it.
const MEMORY_SENTINEL_WARMUP_MS_FOR_TEST = 30 * 60 * 1000;

describe('checkMemorySentinel — module-level ring (real recording path, no samples override)', () => {
  beforeEach(() => __resetMemorySentinelRingForTests());
  afterEach(() => __resetMemorySentinelRingForTests());

  it('records one sample per run() call into the ring and accumulates across invocations', async () => {
    let i = 0;
    const check = checkMemorySentinel({
      sample: () => ({ uptimeMs: i * MIN15, rssBytes: (200 + i * 10) * MIB }),
    });
    // Not enough samples yet after a handful of calls.
    for (; i < 5; i++) {
      const result = await check.run();
      expect(result.message).toContain('not enough post-warmup samples yet');
    }
    // Keep advancing past the warmup + window + sample-count floors.
    for (; i < 21; i++) {
      await check.run();
    }
    const final = await check.run();
    expect(final.ok).toBe(false);
    expect(final.message).toContain('sustained linear RSS growth');
  });

  it('is inconclusive (ok:true) but never throws when the sample source itself throws', async () => {
    const check = checkMemorySentinel({
      sample: () => {
        throw new Error('process.memoryUsage unavailable');
      },
    });
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.message.toLowerCase()).toContain('unavailable');
  });

  it('default sample source (real process.uptime/memoryUsage) runs without throwing', async () => {
    const check = checkMemorySentinel();
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not enough post-warmup samples yet');
  });
});
