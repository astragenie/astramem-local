import { exec } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTaskXml, buildDailyTaskXml } from './task-xml.js';
import { shimPaths, buildHiddenVbs } from './shim.js';
import type { ServiceAdapter, ServiceStatus, InstallResult } from './types.js';

// Exported (not just local consts) so the "Task repetition dormancy" doctor
// canary (issue #370, src/doctor/checks/task-repetition-dormancy.ts) targets
// the SAME two task names this adapter actually registers, instead of
// duplicating the string literals as a second source of truth.
export const TASK_NAME = 'AstraMemoryD';
const BACKUP_TASK_NAME = 'AstraMemoryDBackup';
export const WATCHDOG_TASK_NAME = 'AstraMemoryDWatchdog';

/** User-scope Startup folder. Files placed here auto-run at logon — no admin. */
function startupDir(): string {
  const appdata = process.env['APPDATA'] ?? '';
  return join(appdata, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

function startupScriptPath(): string {
  return join(startupDir(), 'AstraMemoryD.cmd');
}

function backupStartupScriptPath(): string {
  return join(startupDir(), 'AstraMemoryDBackup.cmd');
}

/** Rejection shape from runCmd() — carries the ORIGINAL exec() error's
 *  `.code`/`.signal` alongside whatever the command printed before it
 *  failed, so callers can tell "the command ran and reported a real
 *  negative state" apart from "we could not run/finish the query at all". */
export interface RunCmdError extends Error {
  code?: string | number | null;
  signal?: NodeJS.Signals | null;
  stdout?: string;
}

export function runCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) {
        const wrapped: RunCmdError = new Error(`Command failed: ${cmd}\n${stderr || err.message}`);
        wrapped.code = err.code;
        wrapped.signal = err.signal;
        wrapped.stdout = stdout;
        reject(wrapped);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

/**
 * True when a runCmd() rejection means "we could not determine the
 * answer" (our own timeout killed it, or `schtasks.exe` itself is
 * missing) rather than "the command ran to completion and reported a
 * real negative state" (`schtasks /query` for a task that genuinely
 * doesn't exist exits non-zero promptly with "ERROR: The system cannot
 * find the file specified" — a real answer, not a query failure). This
 * is the exact distinction status() below used to collapse: a query that
 * timed out used to report `installed: false` for a task we already knew
 * existed, telling the user to reinstall a service that was already
 * there and simply slow to answer (ADR-015 rule 4).
 */
export function isInconclusiveFailure(err: unknown): boolean {
  const e = err as RunCmdError;
  return e?.signal != null || e?.code === 'ENOENT';
}

/**
 * Best-effort elevation probe. `net session` succeeds only in an elevated
 * shell; exit code 2 (access denied) means non-elevated. Used for DIAGNOSTICS
 * only — never as a gate: schtasks is always attempted regardless.
 */
export async function isElevated(): Promise<boolean> {
  try {
    await runCmd('net session');
    return true;
  } catch {
    return false;
  }
}

/**
 * Properly quote a Windows command for schtasks /tr.
 * schtasks requires the /tr value to be a single quoted string when it
 * contains spaces. We wrap in double-quotes and escape internal double-quotes.
 */
function quoteForSchtasks(cmd: string): string {
  // Escape backslashes then double-quotes
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Split a possibly-quoted command line into executable + argument string.
 * `"C:\Program Files\nodejs\node.exe" "C:\x\index.js"` →
 *   { command: 'C:\Program Files\nodejs\node.exe', args: '"C:\x\index.js"' }
 */
export function splitCommand(execPath: string): { command: string; args: string } {
  const trimmed = execPath.trim();
  if (trimmed.startsWith('"')) {
    const end = trimmed.indexOf('"', 1);
    if (end > 0) return { command: trimmed.slice(1, end), args: trimmed.slice(end + 1).trim() };
  }
  const sp = trimmed.indexOf(' ');
  if (sp === -1) return { command: trimmed, args: '' };
  return { command: trimmed.slice(0, sp), args: trimmed.slice(sp + 1).trim() };
}

/**
 * Absolute path to the Windows System32 dir — resolved from the environment
 * rather than hardcoded so a relocated Windows install still resolves
 * correctly. Falls back to the near-universal default.
 */
function windowsSystemRoot(): string {
  return process.env['SystemRoot'] || process.env['WINDIR'] || 'C:\\Windows';
}

/**
 * Absolute path to wscript.exe — the windowless script host used to hide
 * the daemon/watchdog/backup tasks' console (D1 "windowless daemon" slice
 * 6). Resolved to an absolute path rather than the bare `wscript.exe` name:
 * Scheduled Task Exec/Command values are passed straight to CreateProcess,
 * not through cmd.exe, so PATH-based resolution is not guaranteed the way
 * it would be from an interactive shell.
 */
function wscriptPath(): string {
  return join(windowsSystemRoot(), 'System32', 'wscript.exe');
}

/**
 * Every registration tier for the daemon task (XML, CLI Tier A, CLI Tier B)
 * must invoke the daemon via `wscript.exe //nologo //B "<vbsPath>"` — never
 * the `.cmd`/execPath directly — or the conhost console-flash this feature
 * exists to close regresses on whichever tier is skipped. `vbsPath` is
 * resolved through `shimPaths()` (the single source of truth for the
 * standard install layout, shim.ts) rather than by string-parsing the
 * caller's `execPath`: production always passes the stable `.cmd` path
 * (install-flow.ts), but this keeps the wrapper correct regardless of what
 * shape a caller's `execPath` happens to take (some unit tests exercise
 * `install()` in isolation with a synthetic `node ...` string that was
 * never a real shim path). `//nologo` suppresses the WScript banner;
 * `//B` is batch mode — no error dialog boxes, matching this task's
 * headless/unattended nature.
 */
function hiddenLaunchExec(): { command: string; args: string } {
  const { vbsPath } = shimPaths();
  return { command: wscriptPath(), args: `//nologo //B "${vbsPath}"` };
}

/**
 * Writes (or overwrites) a hidden-launch VBS wrapper for a NON-daemon
 * scheduled task (backup timer, hang-watchdog probe) at a stable sibling
 * path next to the daemon's own shim trio (`shimPaths().binDir`), then
 * returns the `wscript.exe` Command/Arguments pair that tier should use as
 * its real Exec. Rewritten on every `installBackupTimer`/
 * `installWatchdogTimer` call (install/reinstall re-registers these tasks
 * every time — see install-flow.ts's header) since `commandLine` itself can
 * change per-release (these two tasks bake `build.rawExecPath` directly,
 * unlike the daemon task's stable-pointer indirection — see
 * `install-flow.ts`'s `ResolvedBuild` doc comment) — never left pointing at
 * a stale command line from a prior release.
 */
function installHiddenWrapper(filename: string, commandLine: string): { command: string; args: string } {
  const { binDir } = shimPaths();
  const vbsPath = join(binDir, filename);
  mkdirSync(binDir, { recursive: true });
  writeFileSync(vbsPath, buildHiddenVbs(commandLine), 'utf8');
  return { command: wscriptPath(), args: `//nologo //B "${vbsPath}"` };
}

/** Current user's task-principal id: DOMAIN\user from whoami, else USERNAME. */
async function resolveUserId(): Promise<string> {
  try {
    const out = await runCmd('whoami');
    if (out) return out;
  } catch { /* fall through */ }
  return process.env['USERNAME'] ?? '';
}

/** Return true when the named scheduled task exists (regardless of state). */
async function taskExists(name: string): Promise<boolean> {
  try {
    await runCmd(`schtasks /query /tn "${name}" /fo LIST`);
    return true;
  } catch {
    return false;
  }
}

export class SchtasksAdapter implements ServiceAdapter {
  readonly platform = 'win32' as const;

  async install(execPath: string, port: number): Promise<InstallResult> {
    // Windowless daemon (D1 slice 6): every tier below runs the daemon via
    // wscript.exe hidden-launching the VBS shim.ts's writeShim() writes
    // alongside the .cmd (see hiddenLaunchExec's doc comment) — the raw
    // `execPath`/`port` are no longer part of the actual Exec/Command line;
    // `port` is still threaded through the VBS content itself by writeShim.
    const { command: hiddenCommand, args: hiddenArgs } = hiddenLaunchExec();
    const tr = quoteForSchtasks(`${hiddenCommand} ${hiddenArgs}`);
    const errors: string[] = [];

    // Tier 0 — XML registration. The ONLY form that can express:
    //   ExecutionTimeLimit=PT0S  (CLI-created tasks default to 72h — Task
    //   Scheduler silently kills the daemon after 3 days),
    //   logon trigger WITH a PT5M repetition (no-admin watchdog: re-run is a
    //   <100ms no-op while healthy thanks to the instance lock, and a dead
    //   daemon restarts within 5 minutes),
    //   MultipleInstancesPolicy=IgnoreNew, StartWhenAvailable.
    try {
      const userId = await resolveUserId();
      const xml = buildTaskXml({
        command: hiddenCommand,
        args: hiddenArgs,
        userId,
      });
      const xmlPath = join(tmpdir(), 'AstraMemoryD.xml');
      // Task Scheduler XML declares UTF-16 — write utf16le with an explicit
      // BOM (FF FE) so schtasks parses the file as declared.
      const bom = Buffer.from([0xff, 0xfe]);
      writeFileSync(xmlPath, Buffer.concat([bom, Buffer.from(xml, 'utf16le')]));
      await runCmd(`schtasks /create /tn "${TASK_NAME}" /xml "${xmlPath}" /f`);
      return { kind: 'task' };
    } catch (err0) {
      // Keep the FULL message — the actionable stderr (e.g. "ERROR: Access is
      // denied.") is on line 2 and truncating it hides the root cause.
      errors.push(`Tier 0 (XML): ${(err0 as Error).message}`);
    }

    // Tier A — simplest CLI form: no /RU, no /IT. Task runs in the invoker's
    // security context at logon. NOTE: carries the default 72h
    // ExecutionTimeLimit — the keepalive that XML provides is absent, so this
    // is strictly a fallback.
    const cmdA = `schtasks /create /sc onlogon /tn "${TASK_NAME}" /tr ${tr} /RL LIMITED /f`;
    try {
      await runCmd(cmdA);
      console.log('  · NOTE: task registered via CLI fallback — Task Scheduler applies a default');
      console.log('    72-hour execution limit and no keepalive. Prefer fixing the XML-tier error above.');
      return { kind: 'task' };
    } catch (errA) {
      errors.push(`Tier A: ${(errA as Error).message}`);
    }

    // Tier B — retry with /RU <user> /IT (current legacy behaviour). Some
    // environments refuse Tier A but allow this form.
    const user = process.env['USERNAME'] ?? '';
    const ruFlag = user ? `/RU "${user}" /IT` : '';
    const cmdB = `schtasks /create /sc onlogon /tn "${TASK_NAME}" /tr ${tr} ${ruFlag} /RL LIMITED /f`;
    try {
      await runCmd(cmdB);
      return { kind: 'task' };
    } catch (errB) {
      errors.push(`Tier B: ${(errB as Error).message}`);
    }

    // Tier C — Startup-folder shortcut. No admin required. Runs at next logon.
    // Neither schtasks form worked — surface all errors so the user can
    // diagnose WHY, then fall back gracefully.
    const dir = startupDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const script = `@echo off\nstart "" /B ${execPath} serve --port ${port}\n`;
    const scriptPath = startupScriptPath();
    writeFileSync(scriptPath, script, 'utf8');

    const elevated = await isElevated();
    console.log('  · schtasks unavailable — tried two forms, both failed:');
    for (const msg of errors) {
      for (const line of msg.split('\n')) console.log(`      ${line}`);
    }
    console.log(`  · running elevated: ${elevated ? 'yes' : 'no'}${elevated ? '' : ' — schtasks /create may require an Administrator shell on this system'}`);
    console.log(`  · installed Startup shortcut at:\n    ${scriptPath}`);

    return { kind: 'startup', path: scriptPath };
  }

  async uninstall(): Promise<void> {
    // Remove scheduled task if present (idempotent).
    try { await runCmd(`schtasks /delete /tn "${TASK_NAME}" /f`); } catch { /* not present */ }
    // Remove Startup shortcut if present (idempotent).
    const p = startupScriptPath();
    if (existsSync(p)) {
      try { unlinkSync(p); } catch { /* ignore — parent process lock on Windows */ }
    }
  }

  async start(): Promise<void> {
    if (!(await taskExists(TASK_NAME))) {
      const startupPath = startupScriptPath();
      if (existsSync(startupPath)) {
        throw new Error(
          `AstraMemoryD scheduled task not found.\n` +
          `This install used the Startup-shortcut fallback (schtasks was unavailable at install time).\n` +
          `To start now:  astramem-local serve --port <port>\n` +
          `To install a proper scheduled task, re-run 'astramem-local service install' from an elevated shell.`,
        );
      }
      throw new Error(
        `AstraMemoryD scheduled task not found.\n` +
        `Run 'astramem-local service install' first.`,
      );
    }
    await runCmd(`schtasks /run /tn "${TASK_NAME}"`);
  }

  async stop(): Promise<void> {
    if (!(await taskExists(TASK_NAME))) {
      const startupPath = startupScriptPath();
      if (existsSync(startupPath)) {
        throw new Error(
          `AstraMemoryD scheduled task not found.\n` +
          `This install used the Startup-shortcut fallback (schtasks was unavailable at install time).\n` +
          `The daemon process was started outside schtasks — stop it with: astramem-local serve (Ctrl-C)\n` +
          `Or kill the node process directly via Task Manager.`,
        );
      }
      throw new Error(
        `AstraMemoryD scheduled task not found.\n` +
        `Run 'astramem-local service install' first.`,
      );
    }
    await runCmd(`schtasks /end /tn "${TASK_NAME}"`);
  }

  async status(): Promise<ServiceStatus> {
    // Deliberately does NOT go through taskExists() — that helper collapses
    // ANY query failure (including our own timeout) into `false`, which
    // would make this method fall straight to "no task found" on a
    // transient failure before ever getting a chance to distinguish it.
    // Query directly instead so the three real outcomes (found, genuinely
    // absent, could-not-determine) stay distinguishable end to end.
    const startupPath = startupScriptPath();
    const startupFound = existsSync(startupPath);

    try {
      const out = await runCmd(`schtasks /query /tn "${TASK_NAME}" /fo LIST`);
      const running = /Status:\s*Running/i.test(out);
      return { installed: true, running, detail: out };
    } catch (err) {
      if (isInconclusiveFailure(err)) {
        // We already know NOTHING about whether the task exists — the
        // query itself didn't complete. Reporting `installed: false` here
        // (the pre-fix behavior) told a user whose task was genuinely
        // installed and simply slow to answer to run 'service install'
        // again — a confident, wrong, actionable instruction produced by
        // a timeout (ADR-015 rule 4). Unlike systemd/launchd, there is no
        // cheap independent on-disk check for "does the scheduled task
        // exist" (no local unit-file/plist equivalent — schtasks IS the
        // only source of truth) short of `startupFound`, which is a
        // DIFFERENT install method and routinely false even when the real
        // task is installed and fine. So `installed` defaults to `true`
        // here — erring toward "don't tell them to reinstall" rather than
        // guessing `false` from unrelated evidence. `inconclusive: true`
        // is the actual signal; callers must not trust `installed` alone.
        return {
          installed: true,
          running: false,
          inconclusive: true,
          detail: `could not determine task state (schtasks query failed): ${(err as RunCmdError).message}`,
        };
      }

      // schtasks ran to completion and reported a real failure — on this
      // box, a genuinely-missing task exits 1 promptly with "ERROR: The
      // system cannot find the file specified" (English locale; the exact
      // text may differ elsewhere, but isInconclusiveFailure() keys on the
      // exec-level shape — signal/ENOENT — not this locale-dependent text,
      // so that distinction still holds regardless of locale).
      if (startupFound) {
        // Startup-shortcut fallback — no task, but logon autostart is present.
        return {
          installed: true,
          running: false,
          detail: `Installed via Startup shortcut (no scheduled task): ${startupPath}\n` +
            `'service start/stop' will NOT work. To start: astramem-local serve --port <port>`,
        };
      }

      return { installed: false, running: false, detail: 'Neither scheduled task nor Startup shortcut found.' };
    }
  }

  async installBackupTimer(execPath: string, keep: number): Promise<void> {
    // Windowless daemon (D1 slice 6): wrap the actual backup invocation in
    // its own hidden-launch VBS (distinct file from the daemon's — this
    // task runs `backup --keep N`, not `serve`) so the nightly 03:00 run
    // never flashes a console either. Rewritten every call — `execPath`
    // bakes a specific release's paths (see installHiddenWrapper's doc
    // comment), which can change release to release.
    const { command, args } = installHiddenWrapper('astramemd-backup-hidden.vbs', `${execPath} backup --keep ${keep}`);
    // XML-first, same reason as the daemon task: the CLI /create form needs
    // elevation on some boxes; a current-user XML registration does not.
    try {
      const userId = await resolveUserId();
      const xml = buildDailyTaskXml({
        command,
        args,
        userId,
        description: 'AstraMemory nightly verified backup. Managed by astramem-local reinstall / service install.',
      });
      const xmlPath = join(tmpdir(), 'AstraMemoryDBackup.xml');
      const bom = Buffer.from([0xff, 0xfe]);
      writeFileSync(xmlPath, Buffer.concat([bom, Buffer.from(xml, 'utf16le')]));
      await runCmd(`schtasks /create /tn "${BACKUP_TASK_NAME}" /xml "${xmlPath}" /f`);
      return;
    } catch {
      // fall through to legacy CLI form
    }
    const tr = quoteForSchtasks(`${command} ${args}`);
    const user = process.env['USERNAME'] ?? '';
    const ruFlag = user ? `/RU "${user}" /IT` : '';
    const cmd = `schtasks /create /sc DAILY /st 03:00 /tn "${BACKUP_TASK_NAME}" /tr ${tr} ${ruFlag} /RL LIMITED /f`;
    await runCmd(cmd);
  }

  async uninstallBackupTimer(): Promise<void> {
    try {
      await runCmd(`schtasks /delete /tn "${BACKUP_TASK_NAME}" /f`);
    } catch {
      // Task may not exist — ignore
    }
  }

  /**
   * Hang-watchdog probe task (issue #206, mirroring FEAT-443 SLICE-2's
   * systemd/launchd timer — see watchdog-probe.ts's header for why the
   * PT5M keepalive alone can never catch a wedged-but-lock-holding daemon).
   * Registers a SECOND scheduled task that runs
   * `<execCmd> service watchdog-probe` on its own repeating cadence,
   * independent of the daemon task's own PT5M keepalive tick.
   *
   * XML-first, same reason as install()/installBackupTimer(): a current-user
   * XML registration installs without elevation on boxes where the CLI
   * `/create` form gets "Access is denied". Reuses buildTaskXml's proven
   * logon-trigger-with-repetition shape (task-xml.ts) at `intervalSec`'s
   * cadence instead of the daemon task's fixed PT5M.
   */
  async installWatchdogTimer(execPath: string, intervalSec: number): Promise<void> {
    // Windowless daemon (D1 slice 6): wrap the probe invocation in its own
    // hidden-launch VBS (distinct file from the daemon's/backup's) so the
    // recurring hang-probe never flashes a console either. Rewritten every
    // call — see installHiddenWrapper's doc comment on why.
    const { command, args } = installHiddenWrapper('astramemd-watchdog-hidden.vbs', `${execPath} service watchdog-probe`);
    try {
      const userId = await resolveUserId();
      const xml = buildTaskXml({
        command,
        args,
        userId,
        description: 'AstraMemory hang-watchdog probe. Managed by astramem-local reinstall / service install.',
        repetitionIso: `PT${intervalSec}S`,
      });
      const xmlPath = join(tmpdir(), 'AstraMemoryDWatchdog.xml');
      const bom = Buffer.from([0xff, 0xfe]);
      writeFileSync(xmlPath, Buffer.concat([bom, Buffer.from(xml, 'utf16le')]));
      await runCmd(`schtasks /create /tn "${WATCHDOG_TASK_NAME}" /xml "${xmlPath}" /f`);
      return;
    } catch {
      // Fall through to a legacy CLI form. Unlike the daemon/backup tasks,
      // there's no logon-trigger-with-repetition equivalent in the CLI
      // grammar — /sc MINUTE /mo <n> is the native CLI schedule type for
      // "repeat forever every N minutes", so use that instead of trying to
      // hack together an onlogon+repetition approximation. MINUTE only
      // takes whole minutes, so sub-minute intervalSec values round up to 1.
    }
    const minutes = Math.max(1, Math.round(intervalSec / 60));
    const tr = quoteForSchtasks(`${command} ${args}`);
    const user = process.env['USERNAME'] ?? '';
    const ruFlag = user ? `/RU "${user}" /IT` : '';
    const cmd = `schtasks /create /sc MINUTE /mo ${minutes} /tn "${WATCHDOG_TASK_NAME}" /tr ${tr} ${ruFlag} /RL LIMITED /f`;
    await runCmd(cmd);
  }

  /** Idempotent — no-op if the watchdog task was never installed. */
  async uninstallWatchdogTimer(): Promise<void> {
    try {
      await runCmd(`schtasks /delete /tn "${WATCHDOG_TASK_NAME}" /f`);
    } catch {
      // Task may not exist — ignore
    }
  }
}

/** Exported for tests — resolve the startup-shortcut path without constructing an adapter instance. */
export { startupScriptPath, backupStartupScriptPath };
