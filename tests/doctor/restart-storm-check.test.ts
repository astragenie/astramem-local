/**
 * tests/doctor/restart-storm-check.test.ts (stabilization plan P1.1)
 *
 * checkRestartStorm reads the watchdog's kill log (watchdog-kills.jsonl,
 * written by runWatchdogProbe) and goes RED when the rolling window holds
 * >= RESTART_STORM_THRESHOLD kills — the operator-facing half of the
 * restart-storm circuit breaker. Rate-based per ADR-015: the message always
 * carries the actual count and window.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRestartStorm } from '../../src/doctor/checks/restart-storm.js';
import { watchdogKillsPath, RESTART_STORM_THRESHOLD } from '../../src/service/watchdog-probe.js';

const HOUR = 3_600_000;

function writeKills(dataDir: string, agesMs: number[]): void {
  const now = Date.now();
  const lines = agesMs.map(age => JSON.stringify({ ts: new Date(now - age).toISOString() })).join('\n');
  writeFileSync(watchdogKillsPath(dataDir), `${lines}\n`);
}

describe('checkRestartStorm', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'astramem-restart-storm-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('GREEN when no kill log exists yet', async () => {
    const result = await checkRestartStorm(dataDir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('no watchdog kills');
  });

  it('GREEN with the count when kills stay below threshold in the window', async () => {
    writeKills(dataDir, [1 * HOUR, 2 * HOUR]);
    const result = await checkRestartStorm(dataDir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain(`2 watchdog kill(s)`);
    expect(result.message).toContain(`threshold of ${RESTART_STORM_THRESHOLD}`);
  });

  it('RED with count + timestamps once the window holds threshold kills', async () => {
    writeKills(dataDir, [1 * HOUR, 2 * HOUR, 5 * HOUR]);
    const result = await checkRestartStorm(dataDir).run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('3 watchdog kill(s)');
    expect(result.message).toContain('breaker is OPEN');
    expect(result.fix).toBeTruthy();
  });

  it('kills older than the window do not count — the finding self-clears', async () => {
    writeKills(dataDir, [7 * HOUR, 8 * HOUR, 9 * HOUR]); // all aged out of 6h
    const result = await checkRestartStorm(dataDir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('0 watchdog kill(s)');
  });

  it('malformed lines are skipped, not fatal', async () => {
    const now = Date.now();
    writeFileSync(
      watchdogKillsPath(dataDir),
      `not json\n{"ts":"garbage-date"}\n${JSON.stringify({ ts: new Date(now - HOUR).toISOString() })}\n`,
    );
    const result = await checkRestartStorm(dataDir).run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('1 watchdog kill(s)');
  });
});
