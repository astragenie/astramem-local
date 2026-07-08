/**
 * Tests for ASTRA_MEMORY_ISOLATED=1 in resolveRuntimeConfig().
 *
 * See scripts/eval/longmemeval/README.md's "Isolation" section for the
 * hazard this closes: a daemon spawned with only ASTRA_MEMORY_DATADIR
 * overridden still merged in the real OS config dir's config.yaml + a
 * sync.json paired to a live production tenant, and would have sync-shipped
 * synthetic data there. `ASTRA_MEMORY_ISOLATED=1` is a second, independent
 * guard on top of the existing "redirect APPDATA/HOME to a sandbox"
 * technique: it makes resolveRuntimeConfig refuse to read the real OS config
 * dir at all, and forces sync off regardless of what either file carries.
 *
 * Strategy mirrors datadir.test.ts / migrate-dirs.test.ts: vi.doMock node:os
 * to pin platform() to 'win32' + vi.stubEnv for APPDATA/LOCALAPPDATA, then
 * dynamically re-import resolve-runtime.js fresh per test.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

async function importResolver() {
  vi.doMock('node:os', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');
    return { ...actual, platform: () => 'win32' };
  });
  return import('../../src/config/resolve-runtime.js');
}

describe('resolveRuntimeConfig — ASTRA_MEMORY_ISOLATED', () => {
  let appDataRoot: string;
  let localAppDataRoot: string;
  let evalDataDir: string;
  /** defaultConfigDir() on the mocked win32 platform: join(APPDATA, 'Astramem'). */
  let realConfigDir: string;

  beforeEach(() => {
    vi.resetModules();
    appDataRoot = makeTmpDir('astra-isolated-appdata-');
    localAppDataRoot = makeTmpDir('astra-isolated-localappdata-');
    evalDataDir = makeTmpDir('astra-isolated-datadir-');

    realConfigDir = join(appDataRoot, 'Astramem');
    mkdirSync(realConfigDir, { recursive: true });

    // Plant the exact production hazard: a config.yaml + a sync.json paired
    // to a live-looking cloud tenant, sitting in the real OS config dir.
    writeFileSync(join(realConfigDir, 'config.yaml'), 'port: 9999\n');
    writeFileSync(
      join(realConfigDir, 'sync.json'),
      JSON.stringify({ enabled: true, url: 'https://api.astramemory.com', workspaceId: 'prod-workspace' }),
    );

    vi.stubEnv('APPDATA', appDataRoot);
    vi.stubEnv('LOCALAPPDATA', localAppDataRoot);
    vi.stubEnv('ASTRA_MEMORY_DATADIR', evalDataDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const d of [appDataRoot, localAppDataRoot, evalDataDir]) {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it('control: without the flag, the planted config.yaml + sync.json ARE picked up', async () => {
    const { resolveRuntimeConfig } = await importResolver();
    const result = resolveRuntimeConfig();

    expect(result.isolated).toBe(false);
    expect(result.port).toBe(9999); // from planted config.yaml
    expect(result.cfg.sync.enabled).toBe(true); // from planted sync.json
    expect(result.cfg.sync.url).toBe('https://api.astramemory.com');
    expect(result.configDir).toBe(realConfigDir);
  });

  it('ASTRA_MEMORY_ISOLATED=1 ignores the planted config.yaml + sync.json entirely', async () => {
    vi.stubEnv('ASTRA_MEMORY_ISOLATED', '1');
    const { resolveRuntimeConfig } = await importResolver();
    const result = resolveRuntimeConfig();

    expect(result.isolated).toBe(true);
    expect(result.port).toBe(7777); // defaultConfig() port — config.yaml's 9999 must not leak through
    expect(result.cfg.sync.enabled).toBe(false); // sync.json's live pairing must not leak through
    expect(result.cfg.sync.url).toBe('');
    expect(result.cfg.sync.workspaceId).toBeNull();
    expect(result.configDir).not.toBe(realConfigDir); // never the real OS config dir
    expect(result.dataDir).toBe(evalDataDir);
  });

  it('ASTRA_MEMORY_ISOLATED=1 still applies CLI/env overrides on top of defaults', async () => {
    vi.stubEnv('ASTRA_MEMORY_ISOLATED', '1');
    vi.stubEnv('ASTRA_MEMORY_PORT', '5555');
    const { resolveRuntimeConfig } = await importResolver();
    const result = resolveRuntimeConfig({ dataDir: 'C:\\explicit\\override' });

    expect(result.port).toBe(5555);
    expect(result.dataDir).toBe('C:\\explicit\\override');
    expect(result.sources.dataDir).toBe('cli');
  });

  it('logs the isolated-mode INFO line', async () => {
    vi.stubEnv('ASTRA_MEMORY_ISOLATED', '1');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { resolveRuntimeConfig } = await importResolver();
    resolveRuntimeConfig();

    expect(
      logSpy.mock.calls.some(args => String(args[0]).includes('isolated mode: OS config ignored, sync disabled')),
    ).toBe(true);
    logSpy.mockRestore();
  });

  it('does not log the isolated-mode line when the flag is unset', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { resolveRuntimeConfig } = await importResolver();
    resolveRuntimeConfig();

    expect(logSpy.mock.calls.some(args => String(args[0]).includes('isolated mode'))).toBe(false);
    logSpy.mockRestore();
  });
});
