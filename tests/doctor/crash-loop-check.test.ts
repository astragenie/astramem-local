/**
 * tests/doctor/crash-loop-check.test.ts
 *
 * FEAT-440 AC-3/AC-5: doctor's "Crash loop" check must RED-flag >= 3
 * consecutive non-zero exits in the tail of exit-history.jsonl (printing
 * exit codes, time span, and the crash.log tail), stay GREEN below that
 * threshold, and treat a zero-exit run — including the instance lock's
 * healthy <100ms fast-exit — as resetting the streak regardless of its
 * durationMs (AC-5).
 *
 * Uses `dataDir` (a plain DoctorCheckOpts field) pointed at a fixture dir so
 * exitHistoryPaths(dataDir) resolves under a throwaway tmp dir instead of
 * the real %LOCALAPPDATA%\Astramem.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getChecks } from '../../src/doctor/checks.js';
import { exitHistoryPaths } from '../../src/service/shim.js';

function findCheck(checks: ReturnType<typeof getChecks>, name: string) {
  const c = checks.find(c => c.name === name);
  if (!c) throw new Error(`check not found: ${name}`);
  return c;
}

describe('doctor "Crash loop" check (FEAT-440 AC-3/AC-5)', () => {
  let dir: string;
  let historyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'astra-doctor-crashloop-'));
    const paths = exitHistoryPaths(dir);
    mkdirSync(paths.logsDir, { recursive: true });
    historyPath = paths.historyPath;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function checkFor() {
    return findCheck(getChecks({ dataDir: dir }), 'Crash loop');
  }

  function seed(entries: Array<{ ts: string; exitCode: number; durationMs: number }>) {
    writeFileSync(historyPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  }

  it('ok: no exit-history.jsonl yet', async () => {
    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('no exit history yet');
  });

  it('ok: fewer than 3 consecutive non-zero exits stays GREEN', async () => {
    seed([
      { ts: '2026-07-07T00:00:00.000Z', exitCode: 0, durationMs: 5000 },
      { ts: '2026-07-07T00:05:00.000Z', exitCode: 1, durationMs: 200 },
      { ts: '2026-07-07T00:10:00.000Z', exitCode: 1, durationMs: 180 },
    ]);
    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('below threshold');
  });

  it('RED: >= 3 consecutive non-zero exits — reports exit codes, time span, and crash.log tail', async () => {
    const { crashLogPath } = exitHistoryPaths(dir);
    writeFileSync(crashLogPath, '--- 2026-07-07T00:15:00.000Z exit=1 ---\nError: schema drift at migrate.ts:100\n', 'utf8');
    seed([
      { ts: '2026-07-07T00:00:00.000Z', exitCode: 0, durationMs: 5000 },
      { ts: '2026-07-07T00:05:00.000Z', exitCode: 1, durationMs: 210 },
      { ts: '2026-07-07T00:10:00.000Z', exitCode: 1, durationMs: 190 },
      { ts: '2026-07-07T00:15:00.000Z', exitCode: 1, durationMs: 205 },
    ]);
    const res = await checkFor().run();
    expect(res.ok).toBe(false);
    expect(res.message).toContain('3 consecutive non-zero exits');
    expect(res.message).toContain('[1, 1, 1]');
    expect(res.message).toContain('2026-07-07T00:05:00.000Z');
    expect(res.message).toContain('2026-07-07T00:15:00.000Z');
    expect(res.message).toContain('schema drift at migrate.ts:100');
    expect(res.fix).toBeTruthy();
  });

  it('AC-5: a zero-exit run resets the streak — GREEN even with a long non-zero run before it', async () => {
    seed([
      { ts: '2026-07-07T00:00:00.000Z', exitCode: 1, durationMs: 200 },
      { ts: '2026-07-07T00:05:00.000Z', exitCode: 1, durationMs: 210 },
      { ts: '2026-07-07T00:10:00.000Z', exitCode: 1, durationMs: 190 },
      { ts: '2026-07-07T00:15:00.000Z', exitCode: 0, durationMs: 60000 },
    ]);
    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('0 consecutive non-zero exit');
  });

  it('AC-5: a healthy <100ms fast-exit (exit 0) does not count toward the streak despite its short duration', async () => {
    seed([
      { ts: '2026-07-07T00:00:00.000Z', exitCode: 1, durationMs: 200 },
      { ts: '2026-07-07T00:05:00.000Z', exitCode: 1, durationMs: 210 },
      { ts: '2026-07-07T00:10:00.000Z', exitCode: 1, durationMs: 190 },
      // Instance-lock fast no-op exit: exit 0, durationMs < 100 — must reset,
      // not be mistaken for a crash just because it was fast.
      { ts: '2026-07-07T00:11:00.000Z', exitCode: 0, durationMs: 42 },
    ]);
    const res = await checkFor().run();
    expect(res.ok).toBe(true);
    expect(res.message).toContain('0 consecutive non-zero exit');
  });

  it('malformed lines in exit-history.jsonl are skipped rather than throwing', async () => {
    writeFileSync(historyPath, 'not json\n{"ts":"t","exitCode":1,"durationMs":1}\n', 'utf8');
    const res = await checkFor().run();
    expect(res.ok).toBe(true); // 1 valid non-zero entry < threshold of 3
  });
});
