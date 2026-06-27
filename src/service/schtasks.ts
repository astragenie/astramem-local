import { exec } from 'node:child_process';
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceAdapter, ServiceStatus } from './types.js';

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

function runCmd(cmd: string): Promise<string> {
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

export class SchtasksAdapter implements ServiceAdapter {
  readonly platform = 'win32' as const;

  async install(execPath: string, port: number): Promise<void> {
    // Strategy A: try schtasks /sc onlogon. Survives reboots, runs even with
    // no logged-on user (when /RU permits). Often blocked on Win11 without
    // admin even with /IT /RL LIMITED — environment-dependent.
    const tr = quoteForSchtasks(`${execPath} serve --port ${port}`);
    const user = process.env['USERNAME'] ?? '';
    const ruFlag = user ? `/RU "${user}" /IT` : '';
    const cmd = `schtasks /create /sc onlogon /tn "${TASK_NAME}" /tr ${tr} ${ruFlag} /RL LIMITED /f`;
    try {
      await runCmd(cmd);
      return;
    } catch (err) {
      // Strategy B fallback: drop a .cmd into the user-scope Startup folder.
      // No admin needed. Runs at next logon. Stops at logoff.
      const dir = startupDir();
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const script = `@echo off\nstart "" /B ${execPath} serve --port ${port}\n`;
      writeFileSync(startupScriptPath(), script, 'utf8');
      console.log(
        `  · schtasks blocked (${(err as Error).message.split('\n')[0]}); installed Startup shortcut at:\n    ${startupScriptPath()}`,
      );
      console.log(`  · daemon will auto-start at next logon. To start now, run: astramem-local serve --port ${port}`);
    }
  }

  async uninstall(): Promise<void> {
    try { await runCmd(`schtasks /delete /tn "${TASK_NAME}" /f`); } catch { /* not present */ }
    if (existsSync(startupScriptPath())) {
      try { unlinkSync(startupScriptPath()); } catch { /* ignore */ }
    }
  }

  async start(): Promise<void> {
    await runCmd(`schtasks /run /tn "${TASK_NAME}"`);
  }

  async stop(): Promise<void> {
    // schtasks /end terminates the running instance
    await runCmd(`schtasks /end /tn "${TASK_NAME}"`);
  }

  async status(): Promise<ServiceStatus> {
    try {
      const out = await runCmd(`schtasks /query /tn "${TASK_NAME}" /fo LIST`);
      const installed = true;
      const running = /Status:\s*Running/i.test(out);
      return { installed, running, detail: out };
    } catch (err) {
      // Task not found → not installed
      return { installed: false, running: false, detail: String(err) };
    }
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
