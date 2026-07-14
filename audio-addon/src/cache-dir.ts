import { homedir, platform } from 'node:os';
import { join } from 'node:path';

/**
 * This add-on's own cache directory — deliberately NOT imported from
 * astramem-local's `src/config/datadir.ts` (design doc decision 3: the
 * add-on has zero dependency coupling on the base package, no shared
 * workspace). Same platform-convention family, own namespace
 * ("astramem-audio" instead of "Astramem"/"astra-memory") so the two never
 * collide on disk even when both are present.
 *
 * Windows: %LOCALAPPDATA%\astramem-audio
 * macOS  : ~/Library/Application Support/astramem-audio
 * Linux  : $XDG_CACHE_HOME/astramem-audio (default ~/.cache/astramem-audio)
 */
export function addonCacheDir(): string {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'astramem-audio');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'astramem-audio');
    default:
      return join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'astramem-audio');
  }
}

export function modelsDir(): string {
  return join(addonCacheDir(), 'models');
}

export function binDir(): string {
  return join(addonCacheDir(), 'bin');
}
