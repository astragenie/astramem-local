/**
 * Tests for datadir canonical and legacy path exports.
 *
 * Uses vi.doMock (non-hoisted) + vi.resetModules() so we can control
 * platform() per test without static hoisting ordering issues.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';

// The source joins with the HOST path module (mocking os.platform does not
// change path separators), so expected values must be built with join() too —
// on POSIX runners the final separator is '/'.

describe('defaultDataDir / defaultConfigDir — canonical paths', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns Astramem subdir on Windows (canonical data dir)', async () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\test\\AppData\\Local');
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, platform: () => 'win32' };
    });
    const { defaultDataDir } = await import('../../src/config/datadir.js');
    expect(defaultDataDir()).toBe(join('C:\\Users\\test\\AppData\\Local', 'Astramem'));
  });

  it('returns Astramem subdir on Windows (canonical config dir)', async () => {
    vi.stubEnv('APPDATA', 'C:\\Users\\test\\AppData\\Roaming');
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, platform: () => 'win32' };
    });
    const { defaultConfigDir } = await import('../../src/config/datadir.js');
    expect(defaultConfigDir()).toBe(join('C:\\Users\\test\\AppData\\Roaming', 'Astramem'));
  });

  it('returns AstraMemory subdir for legacy config dir on Windows', async () => {
    vi.stubEnv('APPDATA', 'C:\\Users\\test\\AppData\\Roaming');
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, platform: () => 'win32' };
    });
    const { legacyConfigDir } = await import('../../src/config/datadir.js');
    expect(legacyConfigDir()).toBe(join('C:\\Users\\test\\AppData\\Roaming', 'AstraMemory'));
  });

  it('returns AstraMemory subdir for legacy data dir on Windows', async () => {
    vi.stubEnv('LOCALAPPDATA', 'C:\\Users\\test\\AppData\\Local');
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, platform: () => 'win32' };
    });
    const { legacyDataDir } = await import('../../src/config/datadir.js');
    expect(legacyDataDir()).toBe(join('C:\\Users\\test\\AppData\\Local', 'AstraMemory'));
  });

  it('canonical and legacy differ on Windows (Astramem vs AstraMemory)', async () => {
    vi.stubEnv('APPDATA', 'C:\\Users\\test\\AppData\\Roaming');
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, platform: () => 'win32' };
    });
    const { defaultConfigDir, legacyConfigDir } = await import('../../src/config/datadir.js');
    expect(defaultConfigDir()).not.toBe(legacyConfigDir());
    expect(defaultConfigDir()).toContain('Astramem');
    expect(legacyConfigDir()).toContain('AstraMemory');
  });

  it('canonical and legacy are the same on Linux (no legacy split)', async () => {
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, platform: () => 'linux' };
    });
    const { defaultConfigDir, legacyConfigDir } = await import('../../src/config/datadir.js');
    expect(defaultConfigDir()).toBe(legacyConfigDir());
  });

  it('canonical and legacy are the same on macOS (no legacy split)', async () => {
    vi.doMock('node:os', async () => {
      const actual = await vi.importActual<typeof import('node:os')>('node:os');
      return { ...actual, platform: () => 'darwin' };
    });
    const { defaultConfigDir, legacyConfigDir } = await import('../../src/config/datadir.js');
    expect(defaultConfigDir()).toBe(legacyConfigDir());
  });
});
