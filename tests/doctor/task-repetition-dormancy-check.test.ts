/**
 * tests/doctor/task-repetition-dormancy-check.test.ts (issue #370)
 *
 * checkTaskRepetitionDormancy WARNs when a registered Astra scheduled task's
 * Last Run Time is stale relative to its own repetition interval — the
 * operator-facing signal for the "repetition never armed after
 * (re)registration" class task-xml.ts's TimeTrigger fixes.
 *
 * Deliberately targets THROWAWAY task names (never 'AstraMemoryD' /
 * 'AstraMemoryDWatchdog') via an injected queryTaskImpl — this suite never
 * shells out to the real Task Scheduler or touches live task state.
 */
import { describe, it, expect } from 'vitest';
import {
  checkTaskRepetitionDormancy,
  parseLastRunTime,
  STALE_MULTIPLIER,
  type TaskDormancyTarget,
} from '../../src/doctor/checks/task-repetition-dormancy.js';

const THROWAWAY: TaskDormancyTarget = { taskName: 'AstraMemDoctorTestThrowaway', repetitionSec: 300 };

function schtasksOutput(lastRunTime: string): string {
  return [
    'HostName:                       TESTHOST',
    'TaskName:                       \\AstraMemDoctorTestThrowaway',
    'Next Run Time:                  N/A',
    'Status:                         Ready',
    'Logon Mode:                     Interactive/Background',
    `Last Run Time:                  ${lastRunTime}`,
    'Last Result:                    0',
  ].join('\n');
}

describe('parseLastRunTime', () => {
  it('parses a valid timestamp', () => {
    const result = parseLastRunTime(schtasksOutput('7/16/2026 4:14:00 AM'));
    expect(result.kind).toBe('ok');
  });

  it('reports never-run for "N/A"', () => {
    expect(parseLastRunTime(schtasksOutput('N/A'))).toEqual({ kind: 'never-run' });
  });

  it('reports missing when the field is absent entirely', () => {
    expect(parseLastRunTime('TaskName: \\Foo\nStatus: Ready\n')).toEqual({ kind: 'missing' });
  });

  it('reports unparsable for a garbled value', () => {
    const result = parseLastRunTime(schtasksOutput('not a date'));
    expect(result.kind).toBe('unparsable');
  });
});

describe('checkTaskRepetitionDormancy', () => {
  it('reports not-applicable off win32', async () => {
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => schtasksOutput('N/A'),
      () => Date.now(),
      () => 'linux',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('not applicable');
  });

  it('GREEN when the task has never ticked yet (fresh registration)', async () => {
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => schtasksOutput('N/A'),
      () => Date.now(),
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBeFalsy();
  });

  it('GREEN when the last run is well within the dormancy threshold', async () => {
    const now = Date.parse('2026-07-16T06:00:00');
    const lastRun = new Date(now - 2 * 60_000); // 2 minutes ago, repetition every 5 minutes
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => schtasksOutput(lastRun.toLocaleString('en-US')),
      () => now,
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('ticking on schedule');
  });

  it('RED when the last run is older than 3x the repetition interval — the #370 dormancy signature', async () => {
    const now = Date.parse('2026-07-16T05:50:00');
    // Mirrors the issue's own evidence: 96 minutes stale on a 3-minute (180s) repetition.
    const lastRun = new Date(now - 96 * 60_000);
    const watchdogTarget: TaskDormancyTarget = { taskName: 'AstraMemDoctorTestThrowawayWatchdog', repetitionSec: 180 };
    const check = checkTaskRepetitionDormancy(
      [watchdogTarget],
      STALE_MULTIPLIER,
      async () => schtasksOutput(lastRun.toLocaleString('en-US')),
      () => now,
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('96m ago');
    expect(result.message).toContain(watchdogTarget.taskName);
    expect(result.fix).toBeTruthy();
  });

  it('does not flag a task that genuinely is not registered (query fails, not inconclusive)', async () => {
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => {
        throw new Error('ERROR: The system cannot find the file specified.');
      },
      () => Date.now(),
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBeFalsy();
  });

  it('is inconclusive (never a silent pass) when the query itself could not complete', async () => {
    const inconclusiveErr = Object.assign(new Error('timed out'), { signal: 'SIGTERM' });
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => {
        throw inconclusiveErr;
      },
      () => Date.now(),
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });

  it('is inconclusive when Last Run Time is unparsable', async () => {
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => schtasksOutput('garbled-value'),
      () => Date.now(),
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });

  it('checks multiple targets independently — one dormant does not mask another healthy one, and vice versa', async () => {
    const now = Date.parse('2026-07-16T06:00:00');
    const healthy: TaskDormancyTarget = { taskName: 'ThrowawayHealthy', repetitionSec: 300 };
    const dormant: TaskDormancyTarget = { taskName: 'ThrowawayDormant', repetitionSec: 300 };
    const check = checkTaskRepetitionDormancy(
      [healthy, dormant],
      STALE_MULTIPLIER,
      async (taskName: string) => {
        const lastRun = taskName === healthy.taskName
          ? new Date(now - 60_000) // 1 minute ago
          : new Date(now - 60 * 60_000); // 60 minutes ago — well past 3x5min=15min
        return schtasksOutput(lastRun.toLocaleString('en-US'));
      },
      () => now,
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain(dormant.taskName);
    expect(result.message).not.toContain(`${healthy.taskName}: last ran`);
  });
});
