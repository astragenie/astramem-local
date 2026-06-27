import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export function defaultDataDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'AstraMemory');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astra-memory');
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'astra-memory');
  }
}

export function defaultConfigDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'AstraMemory');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astra-memory');
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'astra-memory');
  }
}
