import { platform } from 'node:os';
import { SystemdAdapter } from './systemd.js';
import { LaunchdAdapter } from './launchd.js';
import { SchtasksAdapter } from './schtasks.js';
import type { ServiceAdapter } from './types.js';

export { type ServiceAdapter, type ServiceStatus } from './types.js';
export { SystemdAdapter } from './systemd.js';
export { LaunchdAdapter } from './launchd.js';
export { SchtasksAdapter } from './schtasks.js';

/**
 * Returns the ServiceAdapter appropriate for the current OS.
 * @param overridePlatform - inject for testing without needing to mock ESM live bindings
 */
export function getServiceAdapter(overridePlatform?: string): ServiceAdapter {
  const p = overridePlatform ?? platform();
  switch (p) {
    case 'linux':
      return new SystemdAdapter();
    case 'darwin':
      return new LaunchdAdapter();
    case 'win32':
      return new SchtasksAdapter();
    default:
      throw new Error(`Unsupported platform: ${p}. AstraMemory service install supports linux, darwin, win32.`);
  }
}
