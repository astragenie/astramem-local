/**
 * Ephemeral APPDATA/HOME + dataDir sandbox for spawning the proxy under
 * test (FEAT-458 S4b). Exists for two reasons, one safety and one
 * measurement:
 *
 * 1. SAFETY (pre-existing gap this file closes): before this, bench.mts
 *    spawned the proxy with the harness's own inherited `process.env`
 *    unmodified — `src/cli/proxy.ts` calls `resolveRuntimeConfig({})` with
 *    no dataDir override, so on a dev box whose real `%APPDATA%\Astramem\
 *    config.yaml` exists (this box's does — see
 *    ../../shared/spawn-daemon.ts's header comment: it is paired to a live
 *    production tenant via sync.json), the spawned proxy would read that
 *    REAL config dir. That was harmless while capture was never exercised
 *    by this harness, but the moment capture is turned on for a bench run,
 *    an unsandboxed spawn would write captured atoms into the operator's
 *    REAL dataDir. This file applies the same APPDATA/LOCALAPPDATA/HOME/
 *    XDG_* redirection ../../shared/spawn-daemon.ts's `makeIsolatedEvalEnv`
 *    already uses for the daemon spawn helpers, independently here (that
 *    module is owned by the other eval harnesses, outside this task's
 *    file-ownership scope) — every proxy spawn in this harness, capture on
 *    or off, now runs against a throwaway sandbox, never the real dirs.
 *
 * 2. MEASUREMENT: `proxy.capture.enabled` (ADR-013 §5) is config-driven
 *    ONLY — `src/cli/proxy.ts` deliberately has no `--capture` CLI flag
 *    ("no one-click toggle"). The only way this test-only harness can drive
 *    a capture-ON proxy run is to control which config.yaml the spawned
 *    process reads, via the same env-var redirection. The SHIPPED default
 *    (`defaultConfig().proxy.capture.enabled === false`,
 *    src/config/config.ts) is never touched — this only ever writes to a
 *    freshly created `mkdtempSync` directory that is discarded by
 *    `cleanup()`.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultConfigDir } from '../../../../src/config/datadir.js';

export interface ProxySandbox {
  root: string;
  configDir: string;
  dataDir: string;
  /** Merge into the spawned child's env (SpawnProxyOpts.env) — never mutates
   *  this (parent) process's env beyond the brief window used to compute
   *  `configDir` above. */
  env: Record<string, string>;
  cleanup(): void;
}

function withEnvOverrides<T>(overrides: Record<string, string>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    process.env[key] = overrides[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(overrides)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

/**
 * Build a throwaway env for one proxy spawn. `captureEnabled` controls the
 * ONE config line that differs from the real shipped default; everything
 * else (encryption off, isolated config/data dirs) matches the existing
 * eval-daemon sandbox precedent (../../shared/spawn-daemon.ts).
 */
export function makeProxySandbox(prefix: string, captureEnabled: boolean): ProxySandbox {
  const root = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const appDataRoot = join(root, 'appdata');
  const localAppDataRoot = join(root, 'localappdata');
  const dataDir = join(root, 'data');
  mkdirSync(appDataRoot, { recursive: true });
  mkdirSync(localAppDataRoot, { recursive: true });
  mkdirSync(dataDir, { recursive: true });

  const dirEnvOverrides: Record<string, string> = {
    APPDATA: appDataRoot,
    LOCALAPPDATA: localAppDataRoot,
    HOME: appDataRoot,
    XDG_CONFIG_HOME: appDataRoot,
    XDG_DATA_HOME: localAppDataRoot,
    // ASTRA_MEMORY_DATADIR sits above config.yaml's own `dataDir` field in
    // resolve-runtime.ts's precedence (CLI flag > this env var >
    // config.yaml > default) — proxy.ts never accepts a --datadir flag, so
    // this env var is the only lever available to this harness.
    ASTRA_MEMORY_DATADIR: dataDir,
  };

  // Computed under the temporarily-overridden env so it matches exactly what
  // the spawned child (which inherits the same overrides) will resolve to —
  // never hardcoded, so this stays correct on every platform datadir.ts
  // supports.
  const configDir = withEnvOverrides(dirEnvOverrides, defaultConfigDir);
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'config.yaml'),
    `security:\n  encryption:\n    enabled: false\nproxy:\n  capture:\n    enabled: ${captureEnabled ? 'true' : 'false'}\n`,
    'utf8',
  );

  return {
    root,
    configDir,
    dataDir,
    env: dirEnvOverrides,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
