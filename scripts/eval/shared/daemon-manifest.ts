/**
 * Shard-daemon PID/port manifest (FEAT-462 slice B, AC-3). Written into the
 * run dir every time a shard daemon is spawned so a cleanup script can kill
 * ONLY those PIDs — the manifest this repo's CLAUDE.md Do-NOT section exists
 * to make possible ("Do NOT kill processes machine-wide by image name ...
 * Kill only PIDs you spawned"). `DaemonHandle.pid` (../shared/spawn-daemon.ts)
 * was groundwork for exactly this, landed unwired in slice A.
 *
 * Written unconditionally (AC-7-safe additive file, same precedent as
 * ../shared/resume-ledger.ts and run-status.ts) using the same tmp+rename
 * atomic-write technique as src/config/writer.ts's writeConfig.
 */
import { writeFileSync, readFileSync, mkdirSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export interface DaemonManifestEntry {
  shard: number;
  label: string;
  /** `undefined` only if spawn itself failed to produce a process (mirrors
   *  DaemonHandle.pid's own type, ../shared/spawn-daemon.ts). */
  pid: number | undefined;
  port: number;
  datadir: string;
}

export interface DaemonManifest {
  run_dir: string;
  updated_at: string;
  daemons: DaemonManifestEntry[];
}

export function daemonManifestPath(runDir: string): string {
  return join(runDir, 'daemon-manifest.json');
}

export function writeDaemonManifest(runDir: string, daemons: DaemonManifestEntry[]): void {
  mkdirSync(runDir, { recursive: true });
  const manifest: DaemonManifest = { run_dir: runDir, updated_at: new Date().toISOString(), daemons };
  const path = daemonManifestPath(runDir);
  const tmpPath = join(runDir, `.daemon-manifest.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), 'utf8');
    renameSync(tmpPath, path);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

export function readDaemonManifest(runDir: string): DaemonManifest | undefined {
  const path = daemonManifestPath(runDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as DaemonManifest;
  } catch {
    return undefined;
  }
}

export interface KillManifestResult {
  killed: number[];
  alreadyDead: number[];
  skipped: number[]; // entries with pid === undefined
}

/**
 * Scoped kill: signals only the PIDs recorded in `manifest`, never a
 * machine-wide image-name sweep. Tolerant of a PID that's already gone
 * (ESRCH) — a cleanup script re-run after a partial cleanup, or racing the
 * daemon's own normal shutdown, is not an error.
 */
export function killManifestDaemons(manifest: DaemonManifest, signal: NodeJS.Signals = 'SIGTERM'): KillManifestResult {
  const result: KillManifestResult = { killed: [], alreadyDead: [], skipped: [] };
  for (const entry of manifest.daemons) {
    if (entry.pid === undefined) { result.skipped.push(-1); continue; }
    try {
      process.kill(entry.pid, signal);
      result.killed.push(entry.pid);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') result.alreadyDead.push(entry.pid);
      else throw err;
    }
  }
  return result;
}
