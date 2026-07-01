import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * Returns the canonical data directory for astramemory-local.
 *
 * Windows: %LOCALAPPDATA%\Astramem  (matches plugin convention; was AstraMemory in <=0.2.2)
 * macOS  : ~/Library/Application Support/astra-memory
 * Linux  : $XDG_DATA_HOME/astra-memory  (default ~/.local/share/astra-memory)
 */
export function defaultDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Astramem');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astra-memory');
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'astra-memory');
  }
}

/**
 * Returns the canonical config directory for astramemory-local.
 *
 * Windows: %APPDATA%\Astramem  (matches plugin convention; was AstraMemory in <=0.2.2)
 * macOS  : ~/Library/Application Support/astra-memory
 * Linux  : $XDG_CONFIG_HOME/astra-memory  (default ~/.config/astra-memory)
 */
export function defaultConfigDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Astramem');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astra-memory');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'astra-memory');
  }
}

/**
 * Returns the LEGACY config directory used by daemon <=0.2.2 on Windows.
 * Non-Windows returns the same value as defaultConfigDir() (no legacy split).
 *
 * Used exclusively by migration and fallback bearer-reader code.
 */
export function legacyConfigDir(): string {
  const home = homedir();
  if (platform() === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'AstraMemory');
  }
  return defaultConfigDir();
}

/**
 * Returns the LEGACY data directory used by daemon <=0.2.2 on Windows.
 * Non-Windows returns the same value as defaultDataDir() (no legacy split).
 *
 * Used exclusively by migration and fallback bearer-reader code.
 */
export function legacyDataDir(): string {
  const home = homedir();
  if (platform() === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'AstraMemory');
  }
  return defaultDataDir();
}
