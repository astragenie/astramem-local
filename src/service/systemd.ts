import { exec } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ServiceAdapter, ServiceStatus } from './types.js';

const SERVICE_NAME = 'astra-memoryd';
const UNIT_FILENAME = `${SERVICE_NAME}.service`;

function unitDir(): string {
  return join(homedir(), '.config', 'systemd', 'user');
}

function unitPath(): string {
  return join(unitDir(), UNIT_FILENAME);
}

function buildUnit(execStart: string, port: number): string {
  return [
    '[Unit]',
    'Description=AstraMemory local memory daemon',
    'After=network.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart} --port ${port}`,
    'Restart=on-failure',
    'RestartSec=5',
    `Environment=ASTRA_MEMORY_PORT=${port}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function runCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10_000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`Command failed: ${cmd}\n${stderr || err.message}`));
      else resolve(stdout.trim());
    });
  });
}

export class SystemdAdapter implements ServiceAdapter {
  readonly platform = 'linux' as const;

  async install(execPath: string, port: number): Promise<void> {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(unitPath(), buildUnit(execPath, port), 'utf8');
    await runCmd(`systemctl --user daemon-reload`);
    await runCmd(`systemctl --user enable ${SERVICE_NAME}`);
  }

  async uninstall(): Promise<void> {
    if (existsSync(unitPath())) {
      try { await runCmd(`systemctl --user stop ${SERVICE_NAME}`); } catch { /* ignore if not running */ }
      try { await runCmd(`systemctl --user disable ${SERVICE_NAME}`); } catch { /* ignore */ }
      unlinkSync(unitPath());
      try { await runCmd(`systemctl --user daemon-reload`); } catch { /* ignore */ }
    }
  }

  async start(): Promise<void> {
    await runCmd(`systemctl --user start ${SERVICE_NAME}`);
  }

  async stop(): Promise<void> {
    await runCmd(`systemctl --user stop ${SERVICE_NAME}`);
  }

  async status(): Promise<ServiceStatus> {
    const installed = existsSync(unitPath());
    if (!installed) return { installed: false, running: false };

    try {
      const out = await runCmd(`systemctl --user is-active ${SERVICE_NAME}`);
      const running = out === 'active';
      return { installed, running, detail: out };
    } catch {
      return { installed, running: false, detail: 'inactive' };
    }
  }
}
