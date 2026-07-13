/**
 * install-flow.ts — the ONE service-install code path (D4).
 *
 * Used by `service install`, `init`, and `reinstall` so there is exactly one
 * implementation of: resolve the current build → write the stable shim →
 * register with the OS scheduler.
 *
 * On ALL platforms (FEAT-443 SLICE-1 — previously Windows-only) the
 * scheduler is pointed at the STABLE shim path, never at the build directly
 * — upgrades only rewrite the shim pointer (see shim.ts). The unit/plist
 * (systemd/launchd) or scheduled task (schtasks) is written exactly once, at
 * first install; a subsequent `reinstall` repoints `current.json` and never
 * re-registers with the scheduler.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getServiceAdapter } from './index.js';
import { writeShim, shimPaths } from './shim.js';
import { resolveRuntimeConfig } from '../config/resolve-runtime.js';
import { hasWatchdogTimer, WATCHDOG_PROBE_INTERVAL_SEC } from './watchdog-probe.js';
import type { InstallResult, ServiceAdapter } from './types.js';

export interface ResolvedBuild {
  nodeBin: string;
  entryJs: string;
  /** `"<node>" "<entryJs>"` — for direct (non-shim) execution, e.g. the
   *  backup timer task which must run `backup --keep N`, not the daemon. */
  rawExecPath: string;
}

/** Resolve the running build's CLI entry from this module's own location. */
export function resolveBuild(): ResolvedBuild {
  const nodeBin = process.execPath;
  const thisFile = new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
  // dist/service/install-flow.js → dist/cli/index.js (URL paths are /-separated)
  const entryJs = thisFile.replace(/service\/install-flow\.(js|ts)$/, 'cli/index.js');
  return { nodeBin, entryJs, rawExecPath: `"${nodeBin}" "${entryJs}"` };
}

export interface InstallFlowOutcome {
  result: InstallResult;
  adapter: ServiceAdapter;
  build: ResolvedBuild;
  /** What the scheduler actually points at — the stable shim, on every platform. */
  taskExecPath: string;
}

export interface InstallFlowOptions {
  /**
   * Override the resolved CLI entry (e.g. a materialized release dir's
   * `dist/cli/index.js`, FEAT-438) instead of the checkout's own `dist/`.
   * `nodeBin` is left as resolveBuild()'s value — only the entry path
   * changes. Used by `reinstall` to pin the served daemon (and its backup
   * timer) to an immutable release; `init` / `service install` omit this and
   * keep pointing at the live checkout as before.
   */
  entryJsOverride?: string;
}

export async function installServiceFlow(port: number, opts: InstallFlowOptions = {}): Promise<InstallFlowOutcome> {
  const adapter = getServiceAdapter();
  const resolved = resolveBuild();
  const build: ResolvedBuild = opts.entryJsOverride
    ? {
        nodeBin: resolved.nodeBin,
        entryJs: opts.entryJsOverride,
        rawExecPath: `"${resolved.nodeBin}" "${opts.entryJsOverride}"`,
      }
    : resolved;

  if (!existsSync(build.entryJs)) {
    throw new Error(
      `CLI entry not found at ${build.entryJs} — the build is missing or partial.\n` +
      `Run: bun install && bun run build`,
    );
  }

  // Service logs rotate under the data dir (see logger.ts ASTRA_LOG_DIR).
  const { dataDir } = resolveRuntimeConfig({ port });
  const logDir = join(dataDir, 'logs');
  // Shim format (batch vs. POSIX shell) is driven by the adapter we already
  // resolved, not a second independent platform() probe inside shimPaths() —
  // one source of truth for "which platform is this install for", and it
  // makes the shim format trivially test-mockable via getServiceAdapter().
  const paths = writeShim({ nodeBin: build.nodeBin, entryJs: build.entryJs, port, logDir }, shimPaths(undefined, adapter.platform));
  console.log(`  · shim written: ${paths.cmdPath}`);
  console.log(`  · pointer     : ${paths.pointerPath} → ${build.entryJs}`);
  // Quoted on every platform: matches the pre-existing Windows convention and
  // is what LaunchdAdapter's arg-tokenizer (`/"([^"]+)"|(\S+)/g`) expects; a
  // quoted single path is also valid systemd ExecStart= syntax.
  const taskExecPath = `"${paths.cmdPath}"`;

  const result = await adapter.install(taskExecPath, port);

  // Hang-watchdog probe timer (FEAT-443 SLICE-2, extended to win32 by issue
  // #206) — hasWatchdogTimer duck-types the capability; all three real
  // adapters (systemd/launchd/schtasks) implement it, so only bare
  // plain-object test mocks that omit the two extra methods skip this as a
  // silent no-op. Registered unconditionally alongside the main unit/plist/
  // task — unlike the backup timer (opt-in via --with-backup-timer), a
  // hang-blind keepalive isn't optional. Best-effort: never fails the
  // overall install.
  if (result.kind === 'task' && hasWatchdogTimer(adapter)) {
    try {
      await adapter.installWatchdogTimer(build.rawExecPath, WATCHDOG_PROBE_INTERVAL_SEC);
      console.log(`  · watchdog probe registered (every ${WATCHDOG_PROBE_INTERVAL_SEC}s)`);
    } catch (err) {
      console.log(`  ⚠ watchdog probe registration failed (non-fatal): ${(err as Error).message}`);
    }
  }

  return { result, adapter, build, taskExecPath };
}
