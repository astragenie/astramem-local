import { exec } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
 * Properly quote a Windows command for schtasks /tr.
 * schtasks requires the /tr value to be a single quoted string when it
 * contains spaces. We wrap in double-quotes and escape internal double-quotes.
 */
function quoteForSchtasks(cmd: string): string {
  // Escape backslashes then double-quotes
  const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `"${escaped}"`;
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

    // Tier A — simplest form: no /RU, no /IT. Task runs in the invoker's
    // security context at logon. Works on Win 10/11 non-admin sessions.
    const cmdA = `schtasks /create /sc onlogon /tn "${TASK_NAME}" /tr ${tr} /RL LIMITED /f`;
    try {
      await runCmd(cmdA);
      return { kind: 'task' };
    } catch (errA) {
      errors.push(`Tier A: ${(errA as Error).message.split('\n')[0]}`);
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
      errors.push(`Tier B: ${(errB as Error).message.split('\n')[0]}`);
    }

    // Tier C — Startup-folder shortcut. No admin required. Runs at next logon.
    // Neither schtasks form worked — surface all errors so the user can
    // diagnose WHY, then fall back gracefully.
    const dir = startupDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const script = `@echo off\nstart "" /B ${execPath} serve --port ${port}\n`;
    const scriptPath = startupScriptPath();
    writeFileSync(scriptPath, script, 'utf8');

    console.log('  · schtasks unavailable — tried two forms, both failed:');
    for (const msg of errors) console.log(`      ${msg}`);
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
