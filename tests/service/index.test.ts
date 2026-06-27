/**
 * Tests for service/index.ts platform dispatch.
 * Uses the optional overridePlatform parameter to test all three branches
 * without ESM live-binding spy limitations.
 */
import { describe, it, expect } from 'vitest';
import { getServiceAdapter } from '../../src/service/index.js';
import { SystemdAdapter } from '../../src/service/systemd.js';
import { LaunchdAdapter } from '../../src/service/launchd.js';
import { SchtasksAdapter } from '../../src/service/schtasks.js';

describe('getServiceAdapter', () => {
  it('returns SystemdAdapter on linux', () => {
    const adapter = getServiceAdapter('linux');
    expect(adapter).toBeInstanceOf(SystemdAdapter);
    expect(adapter.platform).toBe('linux');
  });

  it('returns LaunchdAdapter on darwin', () => {
    const adapter = getServiceAdapter('darwin');
    expect(adapter).toBeInstanceOf(LaunchdAdapter);
    expect(adapter.platform).toBe('darwin');
  });

  it('returns SchtasksAdapter on win32', () => {
    const adapter = getServiceAdapter('win32');
    expect(adapter).toBeInstanceOf(SchtasksAdapter);
    expect(adapter.platform).toBe('win32');
  });

  it('throws on unsupported platform', () => {
    expect(() => getServiceAdapter('freebsd')).toThrow(/unsupported platform/i);
  });

  it('defaults to current process platform without override', () => {
    // Should not throw on win32 (our CI platform)
    const adapter = getServiceAdapter();
    expect(['linux', 'darwin', 'win32']).toContain(adapter.platform);
  });
});
