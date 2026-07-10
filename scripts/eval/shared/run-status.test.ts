import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runStatusPath, writeRunStatus, readRunStatus, patchRunStatus,
  shouldFlushProgress, formatRunStatus, printRunStatus,
  type RunStatus,
} from './run-status.js';

describe('run-status (FEAT-462 slice B, AC-2)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-status-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('readRunStatus returns undefined when no file exists', () => {
    expect(readRunStatus(dir)).toBeUndefined();
  });

  it('writeRunStatus then readRunStatus round-trips', () => {
    const status: RunStatus = {
      status: 'running', phase: 'sampling', orchestrator_pid: 1234, detached: false,
      started_at: '2026-07-10T00:00:00.000Z', updated_at: '2026-07-10T00:00:00.000Z',
      sessions_done: 0, sessions_total: 100,
    };
    writeRunStatus(dir, status);
    expect(existsSync(runStatusPath(dir))).toBe(true);
    expect(readRunStatus(dir)).toEqual(status);
  });

  it('writeRunStatus leaves no stray tmp file behind on success', () => {
    writeRunStatus(dir, {
      status: 'running', phase: 'starting', orchestrator_pid: 1, detached: false,
      started_at: 'x', updated_at: 'x', sessions_done: 0, sessions_total: 0,
    });
    const files = readdirSync(dir);
    expect(files.filter(f => f.includes('.tmp'))).toEqual([]);
  });

  it('readRunStatus tolerates a torn/invalid JSON file (returns undefined, does not throw)', () => {
    writeFileSync(runStatusPath(dir), '{"status": "run', 'utf8'); // truncated JSON
    expect(readRunStatus(dir)).toBeUndefined();
  });

  describe('patchRunStatus', () => {
    it('creates a status from defaults when none exists yet', () => {
      const result = patchRunStatus(dir, { orchestrator_pid: 42, started_at: '2026-07-10T00:00:00.000Z', phase: 'starting' });
      expect(result.status).toBe('running');
      expect(result.detached).toBe(false);
      expect(result.sessions_done).toBe(0);
      expect(result.orchestrator_pid).toBe(42);
      expect(result.phase).toBe('starting');
      expect(readRunStatus(dir)).toEqual(result);
    });

    it('merges over an existing status, only overwriting the given fields', () => {
      patchRunStatus(dir, { orchestrator_pid: 42, started_at: '2026-07-10T00:00:00.000Z', phase: 'starting', sessions_total: 50 });
      const second = patchRunStatus(dir, { orchestrator_pid: 42, started_at: '2026-07-10T00:00:00.000Z', phase: 'ingesting', sessions_done: 10 });
      expect(second.phase).toBe('ingesting');
      expect(second.sessions_done).toBe(10);
      expect(second.sessions_total).toBe(50); // preserved from the first patch
    });

    it('always stamps a fresh updated_at', async () => {
      const first = patchRunStatus(dir, { orchestrator_pid: 1, started_at: 't0', phase: 'starting' });
      await new Promise(resolve => setTimeout(resolve, 5));
      const second = patchRunStatus(dir, { orchestrator_pid: 1, started_at: 't0', phase: 'sampling' });
      expect(second.updated_at).not.toBe(first.updated_at);
    });
  });

  describe('shouldFlushProgress (pure throttle)', () => {
    it('flushes immediately on the first call (lastFlushMs=0, elapsed past the default interval)', () => {
      expect(shouldFlushProgress(0, 2_000)).toBe(true);
    });
    it('does not flush before the interval elapses', () => {
      expect(shouldFlushProgress(1_000, 1_500, 2_000)).toBe(false);
    });
    it('flushes exactly at the interval boundary', () => {
      expect(shouldFlushProgress(1_000, 3_000, 2_000)).toBe(true);
    });
  });

  describe('formatRunStatus / printRunStatus', () => {
    it('formats every core field', () => {
      const text = formatRunStatus({
        status: 'completed', phase: 'completed', orchestrator_pid: 99, detached: true,
        started_at: 's', updated_at: 'u', sessions_done: 5, sessions_total: 5, exit_code: 0,
      });
      expect(text).toContain('status:            completed');
      expect(text).toContain('sessions:           5/5');
      expect(text).toContain('exit_code:          0');
    });

    it('printRunStatus returns 1 and logs an error when no status file exists', () => {
      const errors: string[] = [];
      const spy = console.error;
      console.error = (msg: string) => errors.push(msg);
      try {
        const code = printRunStatus(dir);
        expect(code).toBe(1);
        expect(errors[0]).toMatch(/no run-status\.json found/);
      } finally {
        console.error = spy;
      }
    });

    it('printRunStatus returns 0 and prints the status when a file exists', () => {
      writeRunStatus(dir, {
        status: 'running', phase: 'ingesting', orchestrator_pid: 7, detached: true,
        started_at: 's', updated_at: 'u', sessions_done: 1, sessions_total: 2,
      });
      const logs: string[] = [];
      const spy = console.log;
      console.log = (msg: string) => logs.push(msg);
      try {
        const code = printRunStatus(dir);
        expect(code).toBe(0);
        expect(logs[0]).toContain('sessions:           1/2');
      } finally {
        console.log = spy;
      }
    });
  });
});
