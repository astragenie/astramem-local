/**
 * tests/service/install-flow.test.ts (FEAT-443 SLICE-1)
 *
 * Before this slice, `installServiceFlow` only wrote the stable shim
 * (shim.ts) on win32 — every other platform baked `build.rawExecPath`
 * (`"<node>" "<entryJs>"`) straight into the unit/plist via
 * `taskExecPath = build.rawExecPath`. That meant systemd/launchd installs
 * re-registered the unit/plist on every `reinstall` (the exact stale-pointer
 * problem FEAT-438 closed for Windows), and `reinstall --rollback` had
 * nothing to repoint on those platforms.
 *
 * This suite asserts the unification: `installServiceFlow` now calls
 * `writeShim()` unconditionally, and the exec path handed to
 * `adapter.install()` is always the quoted STABLE SHIM path — never
 * `build.rawExecPath` — regardless of which `ServiceAdapter` platform is
 * resolved. `getServiceAdapter` is mocked (not `node:os`) so the shim format
 * itself (win32 batch vs. POSIX shell) is driven by `adapter.platform`,
 * matching install-flow.ts's "one source of truth" design (shimPaths() is
 * called as `shimPaths(undefined, adapter.platform)`).
 *
 * Isolation: `defaultDataDir()` (the shim's bin-dir root) reads real
 * LOCALAPPDATA/XDG_DATA_HOME/HOME depending on the ACTUAL host OS running
 * this suite (not the mocked adapter platform) — all three are stubbed to a
 * tmp dir so this test can never write into a developer's real astramem
 * data dir regardless of which CI host OS runs it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InstallResult, ServiceAdapter } from '../../src/service/types.js';

function makeMockAdapter(platform: ServiceAdapter['platform'], installResult: InstallResult = { kind: 'task' }) {
  return {
    platform,
    install: vi.fn(async (_execPath: string, _port: number) => installResult),
    uninstall: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    status: vi.fn(async () => ({ installed: true, running: true })),
    installBackupTimer: vi.fn(async () => {}),
    uninstallBackupTimer: vi.fn(async () => {}),
  } satisfies ServiceAdapter;
}

describe('installServiceFlow — cross-platform shim unification (FEAT-443 SLICE-1)', () => {
  let dir: string;
  let localAppDataRoot: string;
  let xdgDataRoot: string;
  let homeRoot: string;
  let fixtureEntry: string;

  beforeEach(() => {
    vi.resetModules();
    dir = mkdtempSync(join(tmpdir(), 'astra-install-flow-'));
    localAppDataRoot = join(dir, 'localappdata');
    xdgDataRoot = join(dir, 'xdgdata');
    homeRoot = join(dir, 'home');
    mkdirSync(localAppDataRoot, { recursive: true });
    mkdirSync(xdgDataRoot, { recursive: true });
    mkdirSync(homeRoot, { recursive: true });

    fixtureEntry = join(dir, 'release', 'dist', 'cli', 'index.js');
    mkdirSync(join(dir, 'release', 'dist', 'cli'), { recursive: true });
    writeFileSync(fixtureEntry, '// fixture entry\n', 'utf8');

    // Redirect every OS-dependent base defaultDataDir() might resolve from,
    // regardless of which real host OS is running this suite. Also isolate
    // resolveRuntimeConfig() (used only for the shim's logDir) from any real
    // config.yaml on disk.
    vi.stubEnv('LOCALAPPDATA', localAppDataRoot);
    vi.stubEnv('XDG_DATA_HOME', xdgDataRoot);
    vi.stubEnv('HOME', homeRoot);
    vi.stubEnv('ASTRA_MEMORY_DATADIR', join(dir, 'data'));
    vi.stubEnv('ASTRA_MEMORY_ISOLATED', '1');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.doUnmock('../../src/service/index.js');
    vi.resetModules();
    rmSync(dir, { recursive: true, force: true });
  });

  it('linux: adapter.install() receives the quoted stable shim path, never rawExecPath', async () => {
    const adapter = makeMockAdapter('linux');
    vi.doMock('../../src/service/index.js', () => ({ getServiceAdapter: () => adapter }));
    const { installServiceFlow } = await import('../../src/service/install-flow.js');

    const outcome = await installServiceFlow(7777, { entryJsOverride: fixtureEntry });

    expect(adapter.install).toHaveBeenCalledTimes(1);
    const [execPathArg, portArg] = adapter.install.mock.calls[0] as [string, number];
    expect(portArg).toBe(7777);
    expect(execPathArg).toBe(outcome.taskExecPath);
    expect(execPathArg).not.toBe(outcome.build.rawExecPath);
    expect(execPathArg.endsWith('astramemd.sh"')).toBe(true);
    expect(execPathArg.startsWith('"')).toBe(true);
  });

  it('linux: writeShim actually wrote a POSIX shell wrapper (not the pre-SLICE-1 raw-exec unit)', async () => {
    const adapter = makeMockAdapter('linux');
    vi.doMock('../../src/service/index.js', () => ({ getServiceAdapter: () => adapter }));
    const { installServiceFlow } = await import('../../src/service/install-flow.js');

    const outcome = await installServiceFlow(7777, { entryJsOverride: fixtureEntry });
    // Strip the quotes installServiceFlow wraps around the shim path.
    const cmdPath = outcome.taskExecPath.slice(1, -1);
    expect(existsSync(cmdPath)).toBe(true);
    const content = readFileSync(cmdPath, 'utf8');
    expect(content.startsWith('#!/bin/sh\n')).toBe(true);
    expect(content).not.toContain('@echo off');
  });

  it('darwin: same unification — quoted stable shim path, POSIX wrapper', async () => {
    const adapter = makeMockAdapter('darwin');
    vi.doMock('../../src/service/index.js', () => ({ getServiceAdapter: () => adapter }));
    const { installServiceFlow } = await import('../../src/service/install-flow.js');

    const outcome = await installServiceFlow(8888, { entryJsOverride: fixtureEntry });

    const [execPathArg] = adapter.install.mock.calls[0] as [string, number];
    expect(execPathArg).not.toBe(outcome.build.rawExecPath);
    expect(execPathArg.endsWith('astramemd.sh"')).toBe(true);

    const cmdPath = execPathArg.slice(1, -1);
    const content = readFileSync(cmdPath, 'utf8');
    expect(content.startsWith('#!/bin/sh\n')).toBe(true);
  });

  it('win32: shim path ends in .cmd and adapter still never sees rawExecPath (unchanged behavior)', async () => {
    const adapter = makeMockAdapter('win32');
    vi.doMock('../../src/service/index.js', () => ({ getServiceAdapter: () => adapter }));
    const { installServiceFlow } = await import('../../src/service/install-flow.js');

    const outcome = await installServiceFlow(7777, { entryJsOverride: fixtureEntry });

    const [execPathArg] = adapter.install.mock.calls[0] as [string, number];
    expect(execPathArg).not.toBe(outcome.build.rawExecPath);
    expect(execPathArg.endsWith('astramemd.cmd"')).toBe(true);

    const cmdPath = execPathArg.slice(1, -1);
    const content = readFileSync(cmdPath, 'utf8');
    expect(content.startsWith('@echo off')).toBe(true);
  });

  it('throws before writing anything if the resolved entry does not exist (unchanged guard)', async () => {
    const adapter = makeMockAdapter('linux');
    vi.doMock('../../src/service/index.js', () => ({ getServiceAdapter: () => adapter }));
    const { installServiceFlow } = await import('../../src/service/install-flow.js');

    await expect(installServiceFlow(7777, { entryJsOverride: join(dir, 'does-not-exist.js') }))
      .rejects.toThrow(/CLI entry not found/);
    expect(adapter.install).not.toHaveBeenCalled();
  });
});
