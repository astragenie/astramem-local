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
import { execFileSync } from 'node:child_process';
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

// ── PID-reuse guard (review fix, Finding 1) ────────────────────────────────
//
// Signaling a manifest's recorded pid with no cross-check is exactly the
// failure class this whole mechanism exists to prevent: if the daemon that
// pid used to belong to has since died and the OS has reused the pid for an
// unrelated process (ordinary OS behavior, and a real risk on the kind of
// long-running, multi-tenant box CLAUDE.md itself describes -- "this box
// runs the production daemon, eval shard daemons, Ollama, and sibling
// agents' processes"), a stale manifest would send a live signal to that
// innocent process. That is precisely the 2026-07-10 incident CLAUDE.md's
// Do-NOT section records, just via PID reuse instead of an image-name
// sweep. `checkPortOwner` verifies the manifest's `port` is STILL bound and
// STILL owned by the manifest's recorded `pid` before any signal is sent.

export type PortOwnerCheck =
  | { ok: true; pid: number | undefined } // ok: the check ran; pid undefined = nothing listening
  | { ok: false; reason: string }; // the check itself couldn't run (missing tool, parse failure, ...)

function parseWindowsNetstat(output: string, port: number): number | undefined {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('TCP')) continue;
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.split(/\s+/);
    // "TCP    127.0.0.1:5001    0.0.0.0:0    LISTENING    12345"
    const localAddr = cols[1];
    const pidCol = cols[cols.length - 1];
    const m = /:(\d+)$/.exec(localAddr ?? '');
    if (!m || Number(m[1]) !== port) continue;
    const pid = Number(pidCol);
    if (Number.isFinite(pid)) return pid;
  }
  return undefined;
}

function parsePosixLsof(output: string): number | undefined {
  const firstLine = output.split(/\r?\n/).find(l => l.trim().length > 0);
  if (!firstLine) return undefined;
  const pid = Number(firstLine.trim());
  return Number.isFinite(pid) ? pid : undefined;
}

/**
 * Which PID (if any) currently owns `port`, verified via the OS itself
 * (`netstat -ano` on Windows -- this box's primary platform; `lsof` on
 * POSIX, best-effort). `ok: false` means the check itself couldn't run
 * (tool missing, unparseable output) -- callers must treat that as "cannot
 * verify identity", never as "confirmed dead" or "confirmed alive".
 */
export function checkPortOwner(port: number): PortOwnerCheck {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
      return { ok: true, pid: parseWindowsNetstat(output, port) };
    } catch (err) {
      return { ok: false, reason: `netstat check failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  try {
    const output = execFileSync('lsof', ['-i', `:${port}`, '-t', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5_000 });
    return { ok: true, pid: parsePosixLsof(output) };
  } catch (err) {
    // lsof exits 1 (throwing under execFileSync) when nothing matches the
    // filter -- a legitimate "not listening" result, not a tool failure.
    // Only a genuinely missing binary is an unrecoverable "can't verify".
    const status = (err as { status?: number }).status;
    if (status === 1) return { ok: true, pid: undefined };
    return { ok: false, reason: `lsof check failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export type KillOutcomeAction = 'killed' | 'already-dead' | 'skipped-identity-mismatch';

export interface KillManifestEntryOutcome {
  shard: number;
  label: string;
  pid: number | undefined;
  port: number;
  action: KillOutcomeAction;
  detail: string;
}

export interface KillManifestResult {
  outcomes: KillManifestEntryOutcome[];
  /** Convenience aggregates derived from `outcomes` for callers that only
   *  need the PID lists (e.g. tests). */
  killed: number[];
  alreadyDead: number[];
  skipped: number[];
}

/**
 * Scoped kill: signals only the PIDs recorded in `manifest`, never a
 * machine-wide image-name sweep — AND only after confirming, via
 * `checkPortOwner`, that the recorded `port` is still bound by the
 * recorded `pid` at the moment of the call. Skip-by-default posture: any
 * ambiguity (port not listening, port owned by a different pid, or the
 * check itself failing) results in NO signal being sent — there is no force
 * flag in this slice. `manifest.updated_at` is surfaced in the outcome
 * `detail` purely as diagnostic context; it is never itself the gate.
 */
export function killManifestDaemons(manifest: DaemonManifest, signal: NodeJS.Signals = 'SIGTERM'): KillManifestResult {
  const outcomes: KillManifestEntryOutcome[] = [];
  for (const entry of manifest.daemons) {
    if (entry.pid === undefined) {
      outcomes.push({
        shard: entry.shard, label: entry.label, pid: undefined, port: entry.port,
        action: 'skipped-identity-mismatch',
        detail: 'manifest entry has no pid recorded -- nothing to verify or signal',
      });
      continue;
    }
    const check = checkPortOwner(entry.port);
    if (!check.ok) {
      outcomes.push({
        shard: entry.shard, label: entry.label, pid: entry.pid, port: entry.port,
        action: 'skipped-identity-mismatch',
        detail: `could not verify who owns port ${entry.port} (${check.reason}) -- refusing to signal pid ${entry.pid} without confirming it's still the daemon (manifest updated_at=${manifest.updated_at})`,
      });
      continue;
    }
    if (check.pid === undefined) {
      outcomes.push({
        shard: entry.shard, label: entry.label, pid: entry.pid, port: entry.port,
        action: 'already-dead',
        detail: `port ${entry.port} is not listening -- daemon already gone (manifest updated_at=${manifest.updated_at})`,
      });
      continue;
    }
    if (check.pid !== entry.pid) {
      outcomes.push({
        shard: entry.shard, label: entry.label, pid: entry.pid, port: entry.port,
        action: 'skipped-identity-mismatch',
        detail: `port ${entry.port} is now owned by pid ${check.pid}, not the manifest's recorded pid ${entry.pid} -- refusing to signal a possibly-unrelated process (manifest updated_at=${manifest.updated_at})`,
      });
      continue;
    }
    try {
      process.kill(entry.pid, signal);
      outcomes.push({
        shard: entry.shard, label: entry.label, pid: entry.pid, port: entry.port,
        action: 'killed',
        detail: `signaled pid ${entry.pid} (confirmed listening on port ${entry.port} at kill time)`,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') throw err;
      outcomes.push({
        shard: entry.shard, label: entry.label, pid: entry.pid, port: entry.port,
        action: 'already-dead',
        detail: `pid ${entry.pid} vanished between the port check and the signal (ESRCH)`,
      });
    }
  }
  return {
    outcomes,
    killed: outcomes.filter(o => o.action === 'killed').map(o => o.pid!),
    alreadyDead: outcomes.filter(o => o.action === 'already-dead').map(o => o.pid).filter((p): p is number => p !== undefined),
    skipped: outcomes.filter(o => o.action === 'skipped-identity-mismatch').map(o => o.pid ?? -1),
  };
}
