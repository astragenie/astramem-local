import { exec } from 'node:child_process';
import type { ServiceAdapter, ServiceStatus } from './types.js';

const TASK_NAME = 'AstraMemoryD';
const BACKUP_TASK_NAME = 'AstraMemoryDBackup';

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
    // Build the task run command: execPath is e.g. "node C:\...\dist\cli\index.js"
    const tr = quoteForSchtasks(`${execPath} serve --port ${port}`);
    // /RU current user + /RL LIMITED: install without admin / no UAC.
    // Without /RU, schtasks defaults the run-as account to SYSTEM for /sc onlogon
    // which requires admin to register.
    const user = process.env['USERNAME'] ?? '';
    const ruFlag = user ? `/RU "${user}"` : '';
    const cmd = `schtasks /create /sc onlogon /tn "${TASK_NAME}" /tr ${tr} ${ruFlag} /RL LIMITED /f`;
    await runCmd(cmd);
  }

  async uninstall(): Promise<void> {
    await runCmd(`schtasks /delete /tn "${TASK_NAME}" /f`);
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
    const ruFlag = user ? `/RU "${user}"` : '';
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
