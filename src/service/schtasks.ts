import { exec } from 'node:child_process';
import type { ServiceAdapter, ServiceStatus } from './types.js';

const TASK_NAME = 'AstraMemoryD';

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
    const cmd = `schtasks /create /sc onlogon /tn "${TASK_NAME}" /tr ${tr} /f`;
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
}
