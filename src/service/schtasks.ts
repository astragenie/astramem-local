import { exec } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTaskXml } from './task-xml.js';
import type { ServiceAdapter, ServiceStatus, InstallResult } from './types.js';

const TASK_NAME = 'AstraMemoryD';
const BACKUP_TASK_NAME = 'AstraMemoryDBackup';

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

export function runCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 15_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Command failed: ${cmd}\n${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
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
    const tr = quoteForSchtasks(`${execPath} serve --port ${port}`);
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
      const { command, args } = splitCommand(execPath);
      const xml = buildTaskXml({
        command,
        args: [args, `serve --port ${port}`].filter(Boolean).join(' '),
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
    const taskFound = await taskExists(TASK_NAME);
    const startupPath = startupScriptPath();
    const startupFound = existsSync(startupPath);

    if (taskFound) {
      try {
        const out = await runCmd(`schtasks /query /tn "${TASK_NAME}" /fo LIST`);
        const running = /Status:\s*Running/i.test(out);
        return { installed: true, running, detail: out };
      } catch (err) {
        return { installed: false, running: false, detail: String(err) };
      }
    }

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

  async installBackupTimer(execPath: string, keep: number): Promise<void> {
    // schtasks daily at 03:00, runs: <node> <indexJs> backup --keep N
    const tr = quoteForSchtasks(`${execPath} backup --keep ${keep}`);
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
}

/** Exported for tests — resolve the startup-shortcut path without constructing an adapter instance. */
export { startupScriptPath, backupStartupScriptPath };
