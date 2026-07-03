/**
 * resolve-runtime.ts — single source of truth for runtime config resolution.
 *
 * Extracted from serve.ts so that serve, doctor, backup, and reinstall all
 * resolve port/dataDir from the SAME inputs with the SAME precedence:
 *
 *   port   : CLI flag > config.yaml > default
 *   dataDir: CLI flag > ASTRA_MEMORY_DATADIR env > config.yaml > default
 *
 * Historically doctor and backup used `defaultConfig()` (never reading
 * config.yaml), so when config.yaml carried a non-default `dataDir` they
 * probed/backed-up a DIFFERENT directory than the daemon was serving from —
 * producing false "file is not a database" doctor failures and backups of
 * the wrong database.
 */
import { loadConfigFromDisk } from './loader.js';
import { defaultConfigDir, defaultDataDir } from './datadir.js';
import { readSyncSettings } from './sync-settings.js';
import { migrateLegacyDirsIfPresent } from './migrate-dirs.js';
import type { Config } from './config.js';

export type ValueSource = 'cli' | 'env' | 'config.yaml' | 'default';

export interface RuntimeConfig {
  cfg: Config;
  port: number;
  dataDir: string;
  configDir: string;
  /** Where each resolved value came from — surfaced by `reinstall` so users
   *  can see WHY the daemon is using a given directory/port. */
  sources: { port: ValueSource; dataDir: ValueSource };
}

export interface RuntimeOverrides {
  port?: number;
  dataDir?: string;
}

export function resolveRuntimeConfig(overrides: RuntimeOverrides = {}): RuntimeConfig {
  // Legacy Windows dir rename (AstraMemory → Astramem) must run before any
  // config read so the canonical config.yaml is the one we load. Idempotent.
  migrateLegacyDirsIfPresent();

  const configDir = defaultConfigDir();
  const cfg = loadConfigFromDisk(configDir);

  // `astramem-local pair` persists sync settings to sync.json — merge them
  // over config.yaml so pairing survives restarts.
  const pairedSync = readSyncSettings(configDir);
  if (pairedSync) {
    cfg.sync = { ...cfg.sync, enabled: pairedSync.enabled, url: pairedSync.url, workspaceId: pairedSync.workspaceId };
  }

  const port = overrides.port ?? cfg.port;
  const portSource: ValueSource = overrides.port !== undefined ? 'cli' : 'config.yaml';

  let dataDir: string;
  let dataDirSource: ValueSource;
  if (overrides.dataDir !== undefined) {
    dataDir = overrides.dataDir;
    dataDirSource = 'cli';
  } else if (process.env.ASTRA_MEMORY_DATADIR) {
    dataDir = process.env.ASTRA_MEMORY_DATADIR;
    dataDirSource = 'env';
  } else {
    dataDir = cfg.dataDir;
    dataDirSource = cfg.dataDir === defaultDataDir() ? 'default' : 'config.yaml';
  }

  return { cfg, port, dataDir, configDir, sources: { port: portSource, dataDir: dataDirSource } };
}
