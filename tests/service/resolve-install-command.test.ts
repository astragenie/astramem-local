import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Issue #305: resolveInstallCommand must prefer a RUNNABLE bun and fall back to
// npm when no bun on this box actually executes (the Windows npm-shim ENOENT
// case). bunRuns probes via spawnSync('<bun>', ['--version']) — mock it so the
// test is deterministic regardless of whether bun is installed on the runner.

const spawnSyncMock = vi.fn();
vi.mock('node:child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Import AFTER the mock is registered.
const { resolveInstallCommand } = await import('../../src/service/release.js');

describe('resolveInstallCommand (issue #305)', () => {
  const savedBunInstall = process.env.BUN_INSTALL;

  beforeEach(() => {
    spawnSyncMock.mockReset();
    delete process.env.BUN_INSTALL; // ignore any real BUN_INSTALL on the runner
  });
  afterEach(() => {
    if (savedBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = savedBunInstall;
  });

  it('falls back to npm when no bun --version probe succeeds', () => {
    // Every `<bun> --version` probe fails (simulates a box with no runnable bun).
    spawnSyncMock.mockReturnValue({ status: 1, error: new Error('spawnSync bun ENOENT') });

    const cmd = resolveInstallCommand();
    expect(cmd.kind).toBe('npm');
    expect(cmd.cmd).toBe('npm');
    expect(cmd.args).toEqual(['install', '--omit=dev']);
    expect(cmd.shell).toBe(true); // win32 needs shell to resolve npm.cmd
  });

  it('prefers bare bun on PATH when its --version probe succeeds', () => {
    // The ~/.bun/bin candidate does not exist on the runner, so the first
    // probe to succeed is the bare `bun` PATH fallback.
    spawnSyncMock.mockImplementation((bin: string) => {
      if (bin === 'bun') return { status: 0, stdout: '1.3.0', error: undefined };
      return { status: 0, stdout: '1.3.0', error: undefined };
    });

    const cmd = resolveInstallCommand();
    expect(cmd.kind).toBe('bun');
    expect(cmd.args).toContain('--frozen-lockfile');
    expect(cmd.shell).toBe(false);
  });
});
