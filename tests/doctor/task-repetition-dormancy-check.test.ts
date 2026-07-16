/**
 * tests/doctor/task-repetition-dormancy-check.test.ts (issue #370)
 *
 * checkTaskRepetitionDormancy WARNs when a registered Astra scheduled task's
 * Last Run Time is stale relative to its own repetition interval — the
 * operator-facing signal for the "repetition never armed after
 * (re)registration" class task-xml.ts's TimeTrigger fixes.
 *
 * PR #379 review: the ORIGINAL version of this canary parsed schtasks'
 * free-text `Last Run Time:` field with `Date.parse` — locale-dependent, and
 * silently WRONG (not just unparsable) on a DD/MM-locale box whenever both
 * day and month are <=12. Fixed by switching to PowerShell's
 * `Get-ScheduledTaskInfo`/`Get-ScheduledTask`, emitting JSON with a real
 * `.NET` round-trip ('o') UTC timestamp — culture-invariant by construction.
 * This suite fixtures that JSON shape directly; see the "never silently
 * misparses..." test below for the regression proof.
 *
 * Deliberately targets THROWAWAY task names (never 'AstraMemoryD' /
 * 'AstraMemoryDWatchdog') via an injected queryTaskImpl — this suite never
 * shells out to the real Task Scheduler or touches live task state.
 */
import { describe, it, expect } from 'vitest';
import {
  checkTaskRepetitionDormancy,
  parseTaskQueryOutput,
  STALE_MULTIPLIER,
  type TaskDormancyTarget,
} from '../../src/doctor/checks/task-repetition-dormancy.js';

const THROWAWAY: TaskDormancyTarget = { taskName: 'AstraMemDoctorTestThrowaway', repetitionSec: 300 };

/** Builds the JSON blob defaultQueryTask's PowerShell script emits.
 *  `lastRunIso` is a `.NET` 'o'-format UTC string (or `null` for "never
 *  run"). `repetitionIso` defaults to 'PT5M' (a live-configured interval is
 *  present in the normal case); pass `null` to simulate a task with no
 *  repeating trigger, forcing the fallback constant. */
function psJson(lastRunIso: string | null, repetitionIso: string | null = 'PT5M'): string {
  return JSON.stringify({ LastRunTime: lastRunIso, RepetitionIso: repetitionIso });
}

/** `.NET` 'o'-format UTC string for a given epoch ms — matches exactly what
 *  `$info.LastRunTime.ToUniversalTime().ToString('o')` produces. */
function dotNetO(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, len = 2): string => String(n).padStart(len, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)}0000Z`
  );
}

describe('parseTaskQueryOutput', () => {
  it('parses a valid UTC timestamp and the live repetition interval', () => {
    const result = parseTaskQueryOutput(psJson(dotNetO(Date.parse('2026-07-16T04:14:00Z')), 'PT5M'));
    expect(result.lastRunTime.kind).toBe('ok');
    expect(result.liveRepetitionSec).toBe(300);
  });

  it('handles fractional seconds up to .NET\'s 7-digit tick precision', () => {
    const result = parseTaskQueryOutput(psJson('2026-07-16T04:14:00.1234567Z'));
    expect(result.lastRunTime.kind).toBe('ok');
    if (result.lastRunTime.kind === 'ok') {
      expect(result.lastRunTime.date.getUTCMilliseconds()).toBe(123);
    }
  });

  it('reports never-run when LastRunTime is null (defaultQueryTask\'s PowerShell script maps Task Scheduler\'s legacy <=1999 "never run" sentinel to null before this parser ever sees it)', () => {
    const result = parseTaskQueryOutput(psJson(null));
    expect(result.lastRunTime).toEqual({ kind: 'never-run' });
  });

  it('reports missing when the output is empty', () => {
    expect(parseTaskQueryOutput('').lastRunTime).toEqual({ kind: 'missing' });
    expect(parseTaskQueryOutput('   ').lastRunTime).toEqual({ kind: 'missing' });
  });

  it('reports unparsable when the output is not valid JSON', () => {
    const result = parseTaskQueryOutput('not json at all');
    expect(result.lastRunTime.kind).toBe('unparsable');
  });

  it('reports unparsable for a garbled LastRunTime value inside otherwise-valid JSON', () => {
    const result = parseTaskQueryOutput(psJson('not a date'));
    expect(result.lastRunTime.kind).toBe('unparsable');
  });

  it('never silently misparses an ambiguous locale-formatted date string — regression for the pre-fix Date.parse hazard', () => {
    // Both day (16) and month (07) are <=12 — genuinely ambiguous as MM/DD
    // vs DD/MM under free-text Date.parse. This is the exact class of bug
    // the PR #379 review found: a wrong-but-successful parse silently
    // produces a false GREEN masking real dormancy. The strict 'o'-format
    // regex must reject this outright rather than guess.
    const result = parseTaskQueryOutput(psJson('16/07/2026 04:14:00'));
    expect(result.lastRunTime.kind).toBe('unparsable');
  });

  it('falls back to null liveRepetitionSec when RepetitionIso is absent (no repeating trigger)', () => {
    const result = parseTaskQueryOutput(psJson(dotNetO(Date.now()), null));
    expect(result.liveRepetitionSec).toBeNull();
  });

  it('falls back to null liveRepetitionSec when RepetitionIso is outside the supported subset', () => {
    const result = parseTaskQueryOutput(psJson(dotNetO(Date.now()), 'P1D')); // days component — unsupported
    expect(result.liveRepetitionSec).toBeNull();
  });
});

describe('checkTaskRepetitionDormancy', () => {
  it('reports not-applicable off win32', async () => {
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => psJson(null),
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
      async () => psJson(null),
      () => Date.now(),
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBeFalsy();
  });

  it('GREEN when the last run is well within the dormancy threshold', async () => {
    const now = Date.parse('2026-07-16T06:00:00Z');
    const lastRunMs = now - 2 * 60_000; // 2 minutes ago, repetition every 5 minutes
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => psJson(dotNetO(lastRunMs), 'PT5M'),
      () => now,
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('ticking on schedule');
  });

  it('RED when the last run is older than 3x the repetition interval — the #370 dormancy signature', async () => {
    const now = Date.parse('2026-07-16T05:50:00Z');
    // Mirrors the issue's own evidence: 96 minutes stale on a 3-minute (180s) repetition.
    const lastRunMs = now - 96 * 60_000;
    const watchdogTarget: TaskDormancyTarget = { taskName: 'AstraMemDoctorTestThrowawayWatchdog', repetitionSec: 180 };
    const check = checkTaskRepetitionDormancy(
      [watchdogTarget],
      STALE_MULTIPLIER,
      async () => psJson(dotNetO(lastRunMs), 'PT180S'),
      () => now,
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('96m ago');
    expect(result.message).toContain(watchdogTarget.taskName);
    expect(result.fix).toBeTruthy();
  });

  it('prefers the LIVE repetition interval over the target\'s fallback constant', async () => {
    const now = Date.parse('2026-07-16T06:00:00Z');
    // Fallback constant says 300s (5min, so 15min threshold) — task would
    // read GREEN at 10 minutes stale under the fallback. Live interval says
    // 60s (1min, so 3min threshold) — the SAME 10-minute staleness must
    // read RED once the live value is honored.
    const lastRunMs = now - 10 * 60_000;
    const target: TaskDormancyTarget = { taskName: 'ThrowawayLiveInterval', repetitionSec: 300 };
    const check = checkTaskRepetitionDormancy(
      [target],
      STALE_MULTIPLIER,
      async () => psJson(dotNetO(lastRunMs), 'PT60S'),
      () => now,
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(false);
    expect(result.message).toContain('repetition is every 1m');
  });

  it('falls back to the target\'s configured repetitionSec when the live interval is unavailable', async () => {
    const now = Date.parse('2026-07-16T06:00:00Z');
    // 4 minutes stale: within the 5min-fallback's 15min threshold (GREEN),
    // but would be RED under a hypothetical live value if one were wrongly
    // assumed — proves the fallback path is actually exercised, not skipped.
    const lastRunMs = now - 4 * 60_000;
    const target: TaskDormancyTarget = { taskName: 'ThrowawayNoLiveInterval', repetitionSec: 300 };
    const check = checkTaskRepetitionDormancy(
      [target],
      STALE_MULTIPLIER,
      async () => psJson(dotNetO(lastRunMs), null), // no repeating trigger configured live
      () => now,
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
  });

  it('does not flag a task that genuinely is not registered (query fails, not inconclusive)', async () => {
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => {
        throw new Error('Get-ScheduledTaskInfo: The system cannot find the file specified.');
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
      async () => psJson('garbled-value'),
      () => Date.now(),
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });

  it('is inconclusive on the ambiguous-locale regression case too, never a false GREEN', async () => {
    const check = checkTaskRepetitionDormancy(
      [THROWAWAY],
      STALE_MULTIPLIER,
      async () => psJson('16/07/2026 04:14:00'),
      () => Date.now(),
      () => 'win32',
    );
    const result = await check.run();
    expect(result.ok).toBe(true);
    expect(result.inconclusive).toBe(true);
  });

  it('checks multiple targets independently — one dormant does not mask another healthy one, and vice versa', async () => {
    const now = Date.parse('2026-07-16T06:00:00Z');
    const healthy: TaskDormancyTarget = { taskName: 'ThrowawayHealthy', repetitionSec: 300 };
    const dormant: TaskDormancyTarget = { taskName: 'ThrowawayDormant', repetitionSec: 300 };
    const check = checkTaskRepetitionDormancy(
      [healthy, dormant],
      STALE_MULTIPLIER,
      async (taskName: string) => {
        const lastRunMs = taskName === healthy.taskName
          ? now - 60_000 // 1 minute ago
          : now - 60 * 60_000; // 60 minutes ago — well past 3x5min=15min
        return psJson(dotNetO(lastRunMs), 'PT5M');
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
