import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Check } from '../../src/doctor/types.js';

// We'll import runner after we write it
import { runChecks, formatTable, formatJson } from '../../src/doctor/runner.js';

function makeCheck(name: string, ok: boolean, message: string, fix?: string): Check {
  return {
    name,
    run: vi.fn().mockResolvedValue({ ok, message, fix }),
  };
}

describe('runChecks', () => {
  it('runs all checks and returns results', async () => {
    const checks: Check[] = [
      makeCheck('SQLite writable', true, 'writable'),
      makeCheck('Daemon reachable', false, 'connection refused', 'astra-memory serve'),
    ];
    const results = await runChecks(checks);
    expect(results).toHaveLength(2);
    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
  });

  it('returns empty array for empty check list', async () => {
    const results = await runChecks([]);
    expect(results).toHaveLength(0);
  });

  it('captures check exceptions as failed result', async () => {
    const throwingCheck: Check = {
      name: 'Throwing check',
      run: vi.fn().mockRejectedValue(new Error('unexpected error')),
    };
    const results = await runChecks([throwingCheck]);
    expect(results[0].ok).toBe(false);
    expect(results[0].message).toContain('unexpected error');
  });
});

describe('formatTable', () => {
  it('shows checkmark for passing checks', () => {
    const results = [
      { name: 'SQLite writable', ok: true, message: 'writable' },
      { name: 'Daemon reachable', ok: false, message: 'connection refused', fix: 'astra-memory serve' },
    ];
    const out = formatTable(results);
    expect(out).toContain('✓');
    expect(out).toContain('✗');
    expect(out).toContain('SQLite writable');
    expect(out).toContain('Daemon reachable');
    expect(out).toContain('astra-memory serve');
  });

  it('does not print fix hint for passing checks', () => {
    const results = [{ name: 'SQLite writable', ok: true, message: 'writable', fix: 'should not appear' }];
    const out = formatTable(results);
    expect(out).not.toContain('should not appear');
  });
});

describe('formatJson', () => {
  it('emits valid JSON with checks array and summary', () => {
    const results = [
      { name: 'SQLite writable', ok: true, message: 'writable' },
      { name: 'Daemon reachable', ok: false, message: 'connection refused', fix: 'astra-memory serve' },
    ];
    const out = formatJson(results);
    const parsed = JSON.parse(out);
    expect(parsed).toHaveProperty('checks');
    expect(parsed).toHaveProperty('summary');
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.summary.ok).toBe(1);
    expect(parsed.summary.fail).toBe(1);
  });

  it('fix field is included when present', () => {
    const results = [{ name: 'test', ok: false, message: 'fail', fix: 'run something' }];
    const out = formatJson(results);
    const parsed = JSON.parse(out);
    expect(parsed.checks[0].fix).toBe('run something');
  });
});

describe('exit code logic', () => {
  it('summary fail count > 0 means exit 1 caller should use', async () => {
    const checks: Check[] = [
      makeCheck('A', true, 'ok'),
      makeCheck('B', false, 'fail'),
    ];
    const results = await runChecks(checks);
    const hasFailures = results.some(r => !r.ok);
    expect(hasFailures).toBe(true);
  });
});
