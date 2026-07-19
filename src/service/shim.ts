/**
 * shim.ts — stable launcher shim for the OS service (D1; FEAT-443 SLICE-1
 * ported this from Windows-only to all three platforms).
 *
 * The scheduler (schtasks / systemd unit / launchd plist) points FOREVER at a
 * stable path under the data-adjacent bin dir:
 *   <defaultDataDir()>/bin/astramemd.cmd   (win32)
 *   <defaultDataDir()>/bin/astramemd.sh    (linux/darwin)
 * which runs
 *   <defaultDataDir()>/bin/launch.cjs
 * which reads
 *   <defaultDataDir()>/bin/current.json   { nodeBin, entryJs, port }
 * and spawns the daemon. `launch.cjs` itself is plain, dependency-free
 * CommonJS that needs no per-platform variant — only the outer wrapper
 * script's format (batch vs. POSIX shell) differs, decided by `shimPaths()`.
 *
 * Upgrades rewrite current.json only — the scheduler is never touched again,
 * so the one failure mode that requires elevation/registration privileges
 * can only occur once, at first install. This also kills the stale-baked-
 * path bug where the scheduler kept launching whichever build happened to
 * run `service install` (systemd/launchd used to bake `rawExecPath` straight
 * into `ExecStart=`/`ProgramArguments` — see install-flow.ts).
 */
import { writeFileSync, mkdirSync, renameSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { platform as osPlatform } from 'node:os';
import { defaultDataDir } from '../config/datadir.js';

/** One line of `exit-history.jsonl` (FEAT-440 AC-1/AC-5). `durationMs` is
 *  what lets a reader (doctor's crash-loop check) tell a real crash apart
 *  from the instance-lock's healthy <100ms fast-exit — both can produce
 *  `exitCode: 0`, but only genuine runs have a non-trivial duration; either
 *  way `exitCode !== 0` is the actual crash signal the streak counts. */
export interface ExitHistoryEntry {
  ts: string;
  exitCode: number;
  durationMs: number;
}

export interface ShimPointer {
  nodeBin: string;
  entryJs: string;
  port: number;
  /** When set, the launcher exports ASTRA_LOG_DIR so the daemon rotates its
   *  JSON logs there (service mode) instead of writing to a discarded stdout. */
  logDir?: string;
  /**
   * Set true ONLY by `reinstall --dev` (FEAT-438 SLICE-418 AC-4): `entryJs`
   * points at the mutable checkout's `dist/` instead of an immutable release
   * dir. writePointer/writeShim round-trip this field like any other — the
   * doctor pointer check and `reinstall --rollback`'s target-selection logic
   * both read it back to tell a dev-pinned install apart from a release-
   * pinned one. Absent/false means release-pinned (the default, safe state).
   */
  devPinned?: boolean;
}

export interface ShimPaths {
  binDir: string;
  cmdPath: string;
  launcherPath: string;
  pointerPath: string;
  /**
   * Hidden-launch VBS wrapper (win32 only, D1 slice 6 "windowless daemon").
   * Present on every platform's `ShimPaths` for a single consistent shape,
   * but only ever written by `writeShim` when `cmdPath` is the `.cmd` form
   * (win32) — linux/darwin never had a console-flash problem (no conhost),
   * so this path is simply unused there. See `buildHiddenVbs`'s doc comment
   * for why the wrapper is a blocking `WScript.Shell.Run` rather than a
   * fire-and-forget one.
   */
  vbsPath: string;
}

export interface ExitHistoryPaths {
  logsDir: string;
  historyPath: string;
  crashLogPath: string;
}

/**
 * Paths for the shim's own crash-loop observability artifacts (FEAT-440) —
 * distinct from the daemon's own rotated file logger (`ASTRA_LOG_DIR`'s
 * `daemon.log`, see log/logger.ts). Lives in the SAME `<dataDir>/logs`
 * directory (install-flow.ts / reinstall.ts already point `ASTRA_LOG_DIR`
 * there) but under different filenames so the two never collide:
 *   - `exit-history.jsonl` — ring-buffered `{ts, exitCode, durationMs}` per
 *     daemon exit, last 50 entries.
 *   - `crash.log` — rolling last-~64KB of captured child stderr, verbatim,
 *     so pre-file-logger boot errors survive the process exiting.
 * `LAUNCHER_SOURCE` below computes the identical path via
 * `join(__dirname, '..', 'logs')` (its `__dirname` is always `binDir`) —
 * this function is the TS-side mirror the doctor "Crash loop" check reads
 * from; the two must stay in lock-step on directory/filenames.
 */
export function exitHistoryPaths(dataDirOverride?: string): ExitHistoryPaths {
  const base = dataDirOverride ?? defaultDataDir();
  const logsDir = join(base, 'logs');
  return {
    logsDir,
    historyPath: join(logsDir, 'exit-history.jsonl'),
    crashLogPath: join(logsDir, 'crash.log'),
  };
}

/**
 * Stable bin dir: <defaultDataDir()>/bin (same root as the data dir; on
 * win32 this is byte-identical to the pre-FEAT-443 `%LOCALAPPDATA%\Astramem\bin`
 * since `defaultDataDir()` already resolves to `%LOCALAPPDATA%\Astramem`).
 *
 * @param dataDirOverride  Test-only seam — overrides the base dir wholesale
 *   (production callers never pass this; they let it resolve from the real
 *   `defaultDataDir()`).
 * @param platformOverride Test-only seam — decides the shim script's format
 *   (win32 → `.cmd` batch, else → POSIX `.sh`) independent of the host OS
 *   running the test, mirroring `getServiceAdapter(overridePlatform)`'s
 *   pattern. Production callers never pass this either.
 */
export function shimPaths(
  dataDirOverride?: string,
  platformOverride: NodeJS.Platform = osPlatform(),
): ShimPaths {
  const base = dataDirOverride ?? defaultDataDir();
  const binDir = join(base, 'bin');
  const isWindowsShim = platformOverride === 'win32';
  return {
    binDir,
    cmdPath: join(binDir, isWindowsShim ? 'astramemd.cmd' : 'astramemd.sh'),
    launcherPath: join(binDir, 'launch.cjs'),
    pointerPath: join(binDir, 'current.json'),
    vbsPath: join(binDir, 'astramemd-hidden.vbs'),
  };
}

/**
 * launch.cjs — plain CommonJS so the shim works with any Node the pointer
 * names, regardless of the package's ESM setup. Kept dependency-free.
 * Cross-platform: no OS-specific logic, so the same source runs unchanged
 * whether invoked from the Windows `.cmd` wrapper or the POSIX `.sh` wrapper.
 *
 * Uses spawnSync (not detached spawn): the scheduler's own process lifetime
 * then matches the daemon's, so `service status` reflects reality and
 * `schtasks /end` / `systemctl --user stop` / `launchctl kill` can actually
 * stop the daemon.
 */
const LAUNCHER_SOURCE = `// astramem-local service launcher — generated by 'service install' / 'reinstall'.
// Reads current.json (written on every install/upgrade) and runs the daemon.
'use strict';
const { readFileSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, fstatSync, readSync, unlinkSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const { join } = require('node:path');

const ts = () => new Date().toISOString();
const pointerPath = join(__dirname, 'current.json');
// FEAT-440: shim's own crash-loop observability artifacts — sibling 'logs'
// dir next to 'bin' (same root ASTRA_LOG_DIR points at), distinct filenames
// from the daemon's own rotated daemon.log. Mirrors exitHistoryPaths() in
// the TS source (shim.ts) — keep the two in lock-step.
const logsDir = join(__dirname, '..', 'logs');
const historyPath = join(logsDir, 'exit-history.jsonl');
const crashLogPath = join(logsDir, 'crash.log');
// Scratch capture target for THIS run's stderr — truncated fresh on every
// launch (see stdio wiring below). Internal to the launcher; never read by
// anything but readTail() right after the child exits.
const stderrScratchPath = join(logsDir, 'crash-stderr.tmp');
// Persistent, operator-tailable capture of THIS run's stdout. The daemon
// writes its human-readable lines ("serving on ...", "embed preflight ok",
// etc.) to stdout, NOT to its pino file logger — under a headless service
// launch those must land somewhere visible or the daemon looks dead even when
// healthy. Truncated fresh per launch (shows the CURRENT run) and never
// unlinked, so 'Get-Content -Wait' / 'tail -f' works.
//
// KNOWN BOUND (follow-up): this file is capped only ACROSS launches (the 'w'
// truncate below), not within a single run. Some job handlers still console.log
// to stdout during normal operation, so under the days/weeks keepalive uptime
// this file grows unbounded — unlike crash.log (bounded via CRASH_LOG_MAX_BYTES
// + readTail). A live parent blocked in spawnSync cannot rotate the child's fd
// mid-run, so the real fix is to route ongoing operational logs through pino
// (daemon.log, already rotated) instead of stdout, leaving stdout for the boot
// banner only. Tracked separately; not addressed here to keep this fix scoped.
const stdoutLogPath = join(logsDir, 'daemon-stdout.log');
const HISTORY_MAX_ENTRIES = 50;
const CRASH_LOG_MAX_BYTES = 64 * 1024;
// Headroom reserved for this entry's own "--- ts exit=N ---" header line
// (well under 100 bytes) when we cap how much of the scratch file's tail we
// pull in. Without this, a single run's stderr alone filling the full
// CRASH_LOG_MAX_BYTES would push appendCrashLog's final "keep last N bytes"
// rotation to chop the header off THIS entry too, not just older ones.
const CRASH_TAIL_READ_BYTES = CRASH_LOG_MAX_BYTES - 1024;

// Ring-buffered append — must never throw (FEAT-440 AC-4): a locked/read-only
// logs dir must not take the shim down. Read-modify-write with tmp+rename
// (same atomic-swap pattern as writePointer in shim.ts) rather than a plain
// append, since we also truncate to the last N entries here.
function appendExitHistory(entry) {
  try {
    mkdirSync(logsDir, { recursive: true });
    let lines = [];
    try {
      lines = readFileSync(historyPath, 'utf8').split('\\n').filter(Boolean);
    } catch (err) { /* first run / no history yet — start fresh */ }
    lines.push(JSON.stringify(entry));
    if (lines.length > HISTORY_MAX_ENTRIES) lines = lines.slice(lines.length - HISTORY_MAX_ENTRIES);
    const tmpPath = historyPath + '.' + process.pid + '.' + Date.now() + '.tmp';
    writeFileSync(tmpPath, lines.join('\\n') + '\\n', 'utf8');
    renameSync(tmpPath, historyPath);
  } catch (err) {
    // Swallowed on purpose — history/crash-log writes can never block or
    // fail the shim (FEAT-440 AC-4).
  }
}

// Reads only the LAST maxBytes of a file straight off disk via a positioned
// read — never loads the whole file into memory. This is what keeps the
// post-exit crash-log merge bounded even if the daemon spewed gigabytes of
// stderr over a multi-week uptime before finally dying: we only ever pull
// the tail we're going to keep, not the whole scratch capture. Returns ''
// (never throws) on any failure — missing file, empty file, transient read
// error — so a capture problem can never surface as a launcher crash.
function readTail(filePath, maxBytes) {
  let fd;
  try {
    fd = openSync(filePath, 'r');
  } catch (err) {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return '';
    const readSize = Math.min(size, maxBytes);
    const buf = Buffer.alloc(readSize);
    readSync(fd, buf, 0, readSize, size - readSize);
    return buf.toString('utf8');
  } catch (err) {
    return '';
  } finally {
    try { closeSync(fd); } catch (err) { /* best-effort */ }
  }
}

// Rolling last-~64KB of captured stderr, verbatim (FEAT-440 AC-2) — persists
// pre-file-logger boot errors (e.g. the migrate.ts:100 schema-drift throw)
// that would otherwise vanish with the exited process. No-op when stderr was
// empty (healthy runs write ~nothing to stderr, so this rarely fires).
function appendCrashLog(entryTs, exitCode, stderrTail) {
  if (!stderrTail) return;
  try {
    mkdirSync(logsDir, { recursive: true });
    let existing = '';
    try { existing = readFileSync(crashLogPath, 'utf8'); } catch (err) { /* first crash */ }
    let combined = existing + '--- ' + entryTs + ' exit=' + exitCode + ' ---\\n' + stderrTail + '\\n';
    if (Buffer.byteLength(combined, 'utf8') > CRASH_LOG_MAX_BYTES) {
      const buf = Buffer.from(combined, 'utf8');
      combined = buf.subarray(buf.length - CRASH_LOG_MAX_BYTES).toString('utf8');
    }
    const tmpPath = crashLogPath + '.' + process.pid + '.' + Date.now() + '.tmp';
    writeFileSync(tmpPath, combined, 'utf8');
    renameSync(tmpPath, crashLogPath);
  } catch (err) {
    // Swallowed — see appendExitHistory.
  }
}

let ptr;
try {
  ptr = JSON.parse(readFileSync(pointerPath, 'utf8'));
} catch (err) {
  console.error(ts() + ' [astramemd-shim] cannot read ' + pointerPath + ': ' + err.message);
  console.error(ts() + ' [astramemd-shim] run: astramem-local reinstall');
  process.exit(1);
}
if (typeof ptr.nodeBin !== 'string' || !ptr.nodeBin || typeof ptr.entryJs !== 'string' || !ptr.entryJs) {
  console.error(ts() + ' [astramemd-shim] current.json missing/invalid nodeBin/entryJs — run: astramem-local reinstall');
  process.exit(1);
}
const env = { ...process.env };
if (ptr.logDir) env.ASTRA_LOG_DIR = ptr.logDir; // service mode: rotated file logs
const args = [ptr.entryJs, 'serve', '--port', String(ptr.port || 7777)];
// Neither stdout nor stderr may be 'inherit'. stdout was formerly 'inherit',
// but a Scheduled Task / headless service launch has no guaranteed valid
// console handle: the daemon's first write to an invalid inherited stdout fd
// kills it before it can do anything — the exact "the service can't keep the
// daemon alive" bug this closes. But 'ignore' is wrong too: the daemon writes
// its human-readable status lines ("serving on ...", "embed preflight ok") to
// stdout, not to its pino file logger, so discarding stdout makes a perfectly
// healthy managed daemon look dead to an operator. Both streams are therefore
// redirected to real OS file descriptors (NOT 'inherit', NOT 'ignore', NOT
// Node's 'pipe'):
//   - stdout -> daemon-stdout.log, persistent + tailable (the operator's view).
//   - stderr -> a scratch file, tailed post-exit into crash.log for FEAT-440
//     crash-loop visibility (Node uncaught exceptions, console.error, the
//     migrate.ts schema-drift throw all go to stderr).
// A real fd needs no valid parent handle at all, so neither the inherit-crash
// nor the invisibility can occur. 'pipe' is specifically avoided because it
// would make spawnSync buffer ALL cumulative output in this process's memory
// for the ENTIRE lifetime of a daemon that can run for days/weeks under the
// keepalive architecture: past Node's default 1MB maxBuffer, spawnSync
// SIGTERM-kills an otherwise-healthy daemon (res.status === null,
// res.error.code === 'ENOBUFS') — a false crash that can itself trigger a
// crash-loop RED alert, directly violating this feature's "the shim must never
// take the daemon down" promise. Raising maxBuffer isn't a fix either — it just
// turns the same buffer into an unbounded multi-week memory leak instead of a
// kill. Handing the child a real fd means the OS writes straight to disk with
// no in-process buffer at all; readTail() below only ever loads the last
// CRASH_LOG_MAX_BYTES back into memory once the child has already exited.
let stderrFd = null;
let stdoutFd = null;
try {
  mkdirSync(logsDir, { recursive: true });
  stdoutFd = openSync(stdoutLogPath, 'w'); // truncate: fresh per run, kept for tailing
  stderrFd = openSync(stderrScratchPath, 'w'); // truncate: fresh capture per run
} catch (err) {
  // Locked/unwritable logs dir — fall back to 'ignore' (NOT 'inherit') rather
  // than block the daemon from starting (AC-4): this run just won't get a
  // daemon-stdout.log / crash.log entry, same "best-effort observability"
  // tradeoff as every other write in this file. 'ignore' (not 'inherit')
  // because an inherited handle under a headless service launch is the very
  // crash this wiring exists to avoid; 'ignore' needs no valid parent handle.
  //
  // stdout opens FIRST, so if the stderr open is what threw, stdoutFd is a
  // live handle here. Close it before nulling — otherwise it never reaches
  // spawnSync or the close block below (both gated on stdoutFd !== null) and
  // leaks for the daemon's entire multi-week lifetime.
  try { if (stdoutFd !== null) closeSync(stdoutFd); } catch (e) { /* best-effort */ }
  stdoutFd = null;
  stderrFd = null;
}
const stdoutStdio = stdoutFd === null ? 'ignore' : stdoutFd;
const stderrStdio = stderrFd === null ? 'ignore' : stderrFd;

// Deliberately no timeout option: this spawnSync call IS the daemon's
// lifetime (the shim blocks here for as long as the daemon runs, which is
// meant to be days/weeks under the keepalive architecture — see this
// file's header). Reviewed as part of the B3 shell-out timeout sweep: not
// a missed cold-start bug, the intended shape of this specific call.
//
// stdin is 'ignore', not 'inherit': the daemon never reads from stdin, and
// under a headless/non-interactive launch (a Windows Scheduled Task run has
// no guarantee of a usable console stdio triplet — 'Run whether user is
// logged on or not', a locked/disconnected session, etc.) an inherited
// handle that nothing will ever use is pure unnecessary risk surface.
// 'ignore' needs no valid parent handle at all.
const startedAt = Date.now();
let exitCode;
let durationMs;
try {
  const res = spawnSync(ptr.nodeBin, args, { stdio: ['ignore', stdoutStdio, stderrStdio], env });
  durationMs = Date.now() - startedAt;
  exitCode = res.status === null ? 1 : res.status;
} catch (err) {
  // spawnSync() itself throwing (as opposed to returning a result object
  // with res.error set — the documented failure shape spawnSync normally
  // uses) is a genuine launcher-level failure, e.g. an argument type
  // spawnSync rejects synchronously. This must still exit non-zero (it is
  // a real failure, not the healthy already-running fast-exit this file
  // exists to get right) — it must just not fall through UNRECORDED to
  // Node's bare uncaught-exception handler, which would exit non-zero too
  // but skip appendExitHistory entirely (this run vanishes from
  // exit-history.jsonl instead of leaving a diagnosable entry) and print no
  // actionable message.
  durationMs = Date.now() - startedAt;
  exitCode = 1;
  console.error(ts() + ' [astramemd-shim] failed to spawn daemon: ' + (err && err.message ? err.message : String(err)));
}

if (stdoutFd !== null) {
  try { closeSync(stdoutFd); } catch (err) { /* best-effort */ }
}
if (stderrFd !== null) {
  try { closeSync(stderrFd); } catch (err) { /* best-effort */ }
}

const exitTs = ts();
appendExitHistory({ ts: exitTs, exitCode, durationMs });
if (stderrFd !== null) {
  const stderrTail = readTail(stderrScratchPath, CRASH_TAIL_READ_BYTES);
  appendCrashLog(exitTs, exitCode, stderrTail);
  try { unlinkSync(stderrScratchPath); } catch (err) { /* best-effort cleanup */ }
}
process.exit(exitCode);
`;

/**
 * Atomically write current.json (tmp-file + rename — same pattern as
 * config/writer.ts's writeConfig / instance-lock.ts's lock steal). A reader
 * (the launcher on daemon start, or a `reinstall` repoint/rollback) must
 * never observe a torn/partial pointer file: rename() is atomic on the same
 * filesystem, so a concurrent read always sees either the complete old
 * pointer or the complete new one (FEAT-438 SLICE-417 AC-4).
 */
export function writePointer(pointer: ShimPointer, pointerPath: string): void {
  const dir = dirname(pointerPath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.current.json.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify(pointer, null, 2) + '\n', 'utf8');
    renameSync(tmpPath, pointerPath);
  } catch (err) {
    // Covers both failure points: writeFileSync (disk full/perms, tmp may
    // not exist yet) and renameSync (tmp exists, rename itself failed).
    // Either way, don't leave a stray .tmp file behind in the bin dir.
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup; tmp may not exist */ }
    throw err;
  }
}

/** `@echo off` + direct invocation — the cmd resolves node from the pointer
 *  at run time via launch.cjs; the cmd itself only needs SOME node on
 *  PATH-less systems, so it uses the pointer's nodeBin directly. CRLF to
 *  match Windows batch-file convention. */
function buildWindowsCmd(pointer: ShimPointer, paths: ShimPaths): string {
  return `@echo off\r\n"${pointer.nodeBin}" "${paths.launcherPath}"\r\n`;
}

/** POSIX shell equivalent of buildWindowsCmd — `exec` replaces the shell
 *  process so the daemon's PID is what systemd/launchd actually track
 *  (matters for `KeepAlive`/`Restart=` semantics and for `stop`/`kill`
 *  targeting the right process). LF line endings. */
function buildPosixShim(pointer: ShimPointer, paths: ShimPaths): string {
  return `#!/bin/sh\nexec "${pointer.nodeBin}" "${paths.launcherPath}"\n`;
}

/**
 * Escape a string for embedding inside a VBScript double-quoted string
 * literal. VBScript has no backslash-escape syntax inside string literals —
 * an embedded `"` is escaped by DOUBLING it (`""`), never `\"`. A naive
 * backslash-escape here would land a literal backslash-quote pair straight
 * into the running command line instead of terminating/reopening the VBS
 * string, corrupting the wrapped command.
 */
function vbsQuote(raw: string): string {
  return `"${raw.replace(/"/g, '""')}"`;
}

/**
 * Hidden-launch VBS wrapper (win32 only, D1 slice 6 "windowless daemon").
 *
 * Root cause this closes: the scheduled task's Exec ultimately runs cmd.exe
 * (via the `.cmd` shim) under `<LogonType>InteractiveToken</LogonType>` —
 * that spawns a real conhost console window that stays open for the
 * daemon's entire lifetime (the PT5M keepalive re-runs it every 5 minutes,
 * so the window either persists or repeatedly flashes). Task Scheduler's
 * `<Hidden>` setting only hides the TASK from the UI, not the window its
 * Action creates — it does not suppress the console at all.
 *
 * `wscript.exe` (schtasks.ts's `hiddenLaunchExec`) is a windowless script
 * host; running a `WScript.Shell.Run` call inside it with `windowStyle = 0`
 * launches the wrapped command with no window whatsoever. The SECOND
 * argument, `bWaitOnReturn`, is set to `True` — this is load-bearing, not
 * incidental:
 *
 *   - `launch.cjs` deliberately uses blocking `spawnSync` (not a detached
 *     spawn) so the scheduler's own process lifetime matches the daemon's —
 *     that is what lets the PT5M keepalive repetition, `schtasks /end`, and
 *     `service status` all reflect reality (see LAUNCHER_SOURCE's header
 *     comment above for the identical rationale on the daemon side).
 *   - A fire-and-forget `Run(cmd, 0, False)` returns to wscript.exe
 *     IMMEDIATELY — Task Scheduler would see the task "finish" in
 *     milliseconds while the wrapped `.cmd`/`launch.cjs`/daemon process
 *     tree kept running headless underneath, completely invisible to the
 *     keepalive/hang-watchdog model (which polls task state and
 *     `daemon.lock`, not "is some orphaned descendant still alive").
 *   - `True` (blocking) makes wscript.exe itself only return once the
 *     wrapped command exits, so the "scheduler process lifetime ==
 *     daemon lifetime" invariant survives this indirection unchanged.
 *
 * @param commandLine  The FULL command line to run, already quoted for
 *   CreateProcess/cmd.exe the same way schtasks.ts's own `/tr` strings are
 *   (e.g. `"C:\...\astramemd.cmd" serve --port 7777` or
 *   `"C:\...\node.exe" "C:\...\index.js" backup --keep 7`) — this function
 *   only handles the VBS-literal escaping, not path quoting.
 */
export function buildHiddenVbs(commandLine: string): string {
  return (
    "' astramem-local windowless launch wrapper — generated by 'service install' / 'reinstall'.\r\n" +
    "' Runs the wrapped command HIDDEN (windowStyle=0) and BLOCKING (bWaitOnReturn=True).\r\n" +
    "' Blocking is required so Task Scheduler's own process lifetime keeps matching the\r\n" +
    "' wrapped daemon/job's lifetime — see shim.ts's buildHiddenVbs doc comment before changing this.\r\n" +
    `CreateObject("WScript.Shell").Run ${vbsQuote(commandLine)}, 0, True\r\n`
  );
}

/**
 * Write (or overwrite) the stable shim trio. Idempotent — we own the whole
 * file contents, so a plain overwrite is safe and self-healing. The pointer
 * (current.json) is written atomically via writePointer(); the cmd/launcher
 * are small, static, and rewritten in full on every call so a torn write
 * there just gets corrected on the next reinstall.
 *
 * The wrapper's format (batch vs. POSIX shell) is decided by `paths.cmdPath`'s
 * extension — set once by `shimPaths()` — rather than re-detecting the host
 * OS here, so a caller that deliberately built `paths` for a specific
 * platform (tests; a cross-compiled install) gets exactly that format.
 */
export function writeShim(pointer: ShimPointer, paths: ShimPaths = shimPaths()): ShimPaths {
  mkdirSync(paths.binDir, { recursive: true });
  const isWindowsShim = paths.cmdPath.toLowerCase().endsWith('.cmd');
  const cmd = isWindowsShim ? buildWindowsCmd(pointer, paths) : buildPosixShim(pointer, paths);
  writeFileSync(paths.cmdPath, cmd, 'utf8');
  if (!isWindowsShim) {
    // Executable bit — harmless best-effort; a filesystem without POSIX
    // permission bits (rare in practice on linux/darwin) shouldn't fail the
    // whole install over a chmod that wouldn't have meant anything there.
    try { chmodSync(paths.cmdPath, 0o755); } catch { /* best-effort */ }
  } else {
    // Windowless daemon (win32 only, D1 slice 6): the scheduled task's real
    // Exec target is wscript.exe running this hidden-launch VBS, never the
    // .cmd directly — see schtasks.ts's hiddenLaunchExec() and
    // buildHiddenVbs's doc comment above. Rewritten on every writeShim()
    // call (install / reinstall / repoint) alongside the .cmd/pointer, so
    // the embedded `serve --port <N>` argument below can never drift from
    // the pointer's actual port — same reasoning as buildWindowsCmd, and
    // just as decorative: the wrapped .cmd ignores all argv (see
    // buildWindowsCmd above), the real port is read from current.json by
    // launch.cjs. References the STABLE `paths.cmdPath`, never a release
    // path — upgrades repoint current.json only, so this file never needs
    // rewriting just because a release rotated.
    const commandLine = `"${paths.cmdPath}" serve --port ${pointer.port}`;
    writeFileSync(paths.vbsPath, buildHiddenVbs(commandLine), 'utf8');
  }
  writeFileSync(paths.launcherPath, LAUNCHER_SOURCE, 'utf8');
  writePointer(pointer, paths.pointerPath);
  return paths;
}
