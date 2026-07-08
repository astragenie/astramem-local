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
import { join } from 'node:path';
import { loadConfigFromDisk } from './loader.js';
import { defaultConfigDir, defaultDataDir } from './datadir.js';
import { readSyncSettings } from './sync-settings.js';
import { migrateLegacyDirsIfPresent } from './migrate-dirs.js';
import { defaultConfig, type Config } from './config.js';
import { ts } from '../log/logger.js';

export type ValueSource = 'cli' | 'env' | 'config.yaml' | 'default';

export interface RuntimeConfig {
  cfg: Config;
  port: number;
  dataDir: string;
  configDir: string;
  /** Where each resolved value came from — surfaced by `reinstall` so users
   *  can see WHY the daemon is using a given directory/port. */
  sources: { port: ValueSource; dataDir: ValueSource };
  /** True when ASTRA_MEMORY_ISOLATED=1 gated this resolution. Surfaced so
   *  callers (serve.ts) can enforce a second, independent sync-disable guard
   *  on top of cfg.sync.enabled. */
  isolated: boolean;
}

export interface RuntimeOverrides {
  port?: number;
  dataDir?: string;
}

/**
 * ASTRA_MEMORY_ISOLATED=1 — testing/eval isolation switch (see
 * scripts/eval/longmemeval/README.md's "Isolation" section for the hazard
 * this closes: a daemon spawned with only ASTRA_MEMORY_DATADIR overridden
 * still inherited the real %APPDATA%\Astramem config dir, including a
 * `sync.json` paired to a live production tenant, and would have
 * sync-shipped synthetic data there).
 *
 * When set, resolution below never reads the real OS config dir at all — no
 * config.yaml merge, no sync.json pairing merge — and sync is forced off
 * regardless of any value either of those files would otherwise have
 * carried. This is a SECOND, independent guard alongside the existing
 * technique of redirecting APPDATA/HOME/XDG_*_HOME to a sandbox
 * (tests/smoke/helpers/daemon.ts, scripts/eval/longmemeval/lib/spawn-daemon.ts)
 * — it protects a caller that sets only ASTRA_MEMORY_DATADIR and forgets (or
 * cannot, e.g. a shared box) to also redirect the OS dirs.
 */
function isIsolated(): boolean {
  return process.env.ASTRA_MEMORY_ISOLATED === '1';
}

export function resolveRuntimeConfig(overrides: RuntimeOverrides = {}): RuntimeConfig {
  const isolated = isIsolated();

  let cfg: Config;
  let configDir = '';

  if (isolated) {
    // No migrateLegacyDirsIfPresent(), no loadConfigFromDisk(), no
    // readSyncSettings() — none of those touch anything but the real OS
    // config dir, which isolated mode must never read. cfg is defaults only;
    // env-var overrides (ASTRA_MEMORY_PORT, ASTRA_MEMORY_DATADIR) still apply
    // below, same as any other mode.
    cfg = defaultConfig();
  } else {
    // Legacy Windows dir rename (AstraMemory → Astramem) must run before any
    // config read so the canonical config.yaml is the one we load. Idempotent.
    migrateLegacyDirsIfPresent();

    configDir = defaultConfigDir();
    cfg = loadConfigFromDisk(configDir);

    // `astramem-local pair` persists sync settings to sync.json — merge them
    // over config.yaml so pairing survives restarts.
    const pairedSync = readSyncSettings(configDir);
    if (pairedSync) {
      cfg.sync = { ...cfg.sync, enabled: pairedSync.enabled, url: pairedSync.url, workspaceId: pairedSync.workspaceId };
    }
  }

  if (isolated) {
    // Hard-disable regardless of any config value — the whole point of this
    // mode is that a synthetic/eval daemon must never ship to a real cloud
    // tenant, even if some future code path grows another source of
    // cfg.sync. Nothing merges a nonzero value into it above, but this stays
    // correct if that ever changes.
    cfg = { ...cfg, sync: { ...cfg.sync, enabled: false } };
  }

  // ASTRA_MEMORY_PORT sits between the CLI flag and config.yaml — the
  // systemd unit has always set it (it was a dead env until W1.4).
  const envPort = process.env.ASTRA_MEMORY_PORT ? Number(process.env.ASTRA_MEMORY_PORT) : undefined;
  const port = overrides.port ?? (Number.isInteger(envPort) ? (envPort as number) : undefined) ?? cfg.port;
  const portSource: ValueSource =
    overrides.port !== undefined ? 'cli' : Number.isInteger(envPort) ? 'env' : 'config.yaml';

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

  if (isolated) {
    // Adjacent-to-data config path, per the task's "if present" allowance —
    // nothing reads a config.yaml/sync.json from here today (isolated mode
    // skips that merge entirely above), but configDir must still point
    // somewhere sandboxed rather than the real OS dir for callers that
    // report or probe it (e.g. doctor, reinstall).
    configDir = dataDir === ':memory:' ? dataDir : join(dataDir, 'config');
    console.log(`${ts()} [astramem-local] isolated mode: OS config ignored, sync disabled`);
  }

  return { cfg, port, dataDir, configDir, sources: { port: portSource, dataDir: dataDirSource }, isolated };
}
