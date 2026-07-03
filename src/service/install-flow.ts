/**
 * install-flow.ts — the ONE service-install code path (D4).
 *
 * Used by `service install`, `init`, and `reinstall` so there is exactly one
 * implementation of: resolve the current build → (Windows) write the stable
 * shim → register with the OS scheduler.
 *
 * On Windows the scheduler is pointed at the STABLE shim path, never at the
 * build directly — upgrades only rewrite the shim pointer (see shim.ts).
 */
import { existsSync } from 'node:fs';
import { getServiceAdapter } from './index.js';
import { writeShim, shimPaths } from './shim.js';
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
  /** What the scheduler actually points at (shim on Windows). */
  taskExecPath: string;
}

export async function installServiceFlow(port: number): Promise<InstallFlowOutcome> {
  const adapter = getServiceAdapter();
  const build = resolveBuild();

  if (!existsSync(build.entryJs)) {
    throw new Error(
      `CLI entry not found at ${build.entryJs} — the build is missing or partial.\n` +
      `Run: bun install && bun run build`,
    );
  }

  let taskExecPath: string;
  if (adapter.platform === 'win32') {
    const paths = writeShim({ nodeBin: build.nodeBin, entryJs: build.entryJs, port }, shimPaths());
    console.log(`  · shim written: ${paths.cmdPath}`);
    console.log(`  · pointer     : ${paths.pointerPath} → ${build.entryJs}`);
    taskExecPath = `"${paths.cmdPath}"`;
  } else {
    taskExecPath = build.rawExecPath;
  }

  const result = await adapter.install(taskExecPath, port);
  return { result, adapter, build, taskExecPath };
}
