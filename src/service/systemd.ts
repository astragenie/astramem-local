import { exec } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ServiceAdapter, ServiceStatus, InstallResult } from './types.js';

const SERVICE_NAME = 'astra-memoryd';
const UNIT_FILENAME = `${SERVICE_NAME}.service`;
const BACKUP_SERVICE_FILENAME = `${SERVICE_NAME}-backup.service`;
const BACKUP_TIMER_FILENAME = `${SERVICE_NAME}-backup.timer`;
const WATCHDOG_SERVICE_FILENAME = `${SERVICE_NAME}-watchdog.service`;
const WATCHDOG_TIMER_FILENAME = `${SERVICE_NAME}-watchdog.timer`;

function unitDir(): string {
  return join(homedir(), '.config', 'systemd', 'user');
}

function unitPath(): string {
  return join(unitDir(), UNIT_FILENAME);
}

function backupServicePath(): string {
  return join(unitDir(), BACKUP_SERVICE_FILENAME);
}

function backupTimerPath(): string {
  return join(unitDir(), BACKUP_TIMER_FILENAME);
}

function watchdogServicePath(): string {
  return join(unitDir(), WATCHDOG_SERVICE_FILENAME);
}

function watchdogTimerPath(): string {
  return join(unitDir(), WATCHDOG_TIMER_FILENAME);
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

function buildBackupService(execCmd: string, keep: number): string {
  return [
    '[Unit]',
    'Description=AstraMemory nightly backup',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${execCmd} backup --keep ${keep}`,
    '',
  ].join('\n');
}

function buildBackupTimer(): string {
  return [
    '[Unit]',
    'Description=AstraMemory nightly backup timer',
    '',
    '[Timer]',
    'OnCalendar=03:00',
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
}

/**
 * Hang-watchdog probe unit (FEAT-443 SLICE-2) — a oneshot that runs
 * `<execCmd> service watchdog-probe` (watchdog-probe.ts's runWatchdogProbe).
 * `Restart=on-failure` on the MAIN daemon unit only fires on process exit;
 * this is the piece that catches a daemon that's alive but wedged.
 */
function buildWatchdogService(execCmd: string): string {
  return [
    '[Unit]',
    'Description=AstraMemory hang-watchdog probe',
    '',
    '[Service]',
    'Type=oneshot',
    `ExecStart=${execCmd} service watchdog-probe`,
    '',
  ].join('\n');
}

/**
 * `OnUnitActiveSec` (not `OnCalendar`) so the interval is relative to the
 * PREVIOUS run's completion, not wall-clock — matches the semantics of the
 * Windows PT5M logon-trigger repetition this mirrors (task-xml.ts).
 * `OnBootSec` gives the first probe a short head start after boot rather
 * than waiting a full interval before the first check.
 */
function buildWatchdogTimer(intervalSec: number): string {
  return [
    '[Unit]',
    'Description=AstraMemory hang-watchdog probe timer',
    '',
    '[Timer]',
    `OnBootSec=${Math.min(intervalSec, 60)}s`,
    `OnUnitActiveSec=${intervalSec}s`,
    'Persistent=true',
    '',
    '[Install]',
    'WantedBy=timers.target',
    '',
  ].join('\n');
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

function runCmd(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10_000 }, (err, stdout, stderr) => {
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
 * answer" (our own timeout killed it, or `systemctl` itself is missing)
 * rather than "the command ran to completion and reported a real
 * non-'active' state" (e.g. `systemctl is-active` exits non-zero for
 * inactive/failed/activating — a genuine answer, not a query failure).
 * Collapsing these two was the exact bug this check exists to fix: a
 * transient/timeout failure used to render identically to a confirmed
 * "not running".
 */
function isInconclusiveFailure(err: unknown): boolean {
  const e = err as RunCmdError;
  return e?.signal != null || e?.code === 'ENOENT';
}

export class SystemdAdapter implements ServiceAdapter {
  readonly platform = 'linux' as const;

  async install(execPath: string, port: number): Promise<InstallResult> {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(unitPath(), buildUnit(execPath, port), 'utf8');
    await runCmd(`systemctl --user daemon-reload`);
    await runCmd(`systemctl --user enable ${SERVICE_NAME}`);
    return { kind: 'task' };
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
    } catch (err) {
      if (isInconclusiveFailure(err)) {
        return {
          installed,
          running: false,
          inconclusive: true,
          detail: `could not determine running state (systemctl query failed): ${(err as RunCmdError).message}`,
        };
      }
      // `is-active` exits non-zero for every state OTHER than 'active'
      // (inactive, failed, activating, ...) but still PRINTS that state —
      // a genuine answer, not a query failure. Report it instead of a
      // hardcoded 'inactive' so 'failed'/'activating' aren't misreported.
      const reported = (err as RunCmdError).stdout?.trim();
      return { installed, running: false, detail: reported || 'inactive' };
    }
  }

  async installBackupTimer(execPath: string, keep: number): Promise<void> {
    mkdirSync(unitDir(), { recursive: true });
    const execCmd = execPath; // already formatted as `"node" "index.js"`
    writeFileSync(backupServicePath(), buildBackupService(execCmd, keep), 'utf8');
    writeFileSync(backupTimerPath(), buildBackupTimer(), 'utf8');
    await runCmd(`systemctl --user daemon-reload`);
    await runCmd(`systemctl --user enable --now ${SERVICE_NAME}-backup.timer`);
  }

  async uninstallBackupTimer(): Promise<void> {
    const timerPath = backupTimerPath();
    const svcPath = backupServicePath();
    if (existsSync(timerPath)) {
      try { await runCmd(`systemctl --user stop ${SERVICE_NAME}-backup.timer`); } catch { /* ignore */ }
      try { await runCmd(`systemctl --user disable ${SERVICE_NAME}-backup.timer`); } catch { /* ignore */ }
      unlinkSync(timerPath);
    }
    if (existsSync(svcPath)) {
      unlinkSync(svcPath);
    }
    try { await runCmd(`systemctl --user daemon-reload`); } catch { /* ignore */ }
  }

  /** FEAT-443 SLICE-2 — see watchdog-probe.ts header for why this exists
   *  instead of WatchdogSec + sd_notify. Not part of ServiceAdapter (see
   *  watchdog-probe.ts's hasWatchdogTimer guard) — install-flow.ts and
   *  cli/service.ts detect it via duck typing. */
  async installWatchdogTimer(execPath: string, intervalSec: number): Promise<void> {
    mkdirSync(unitDir(), { recursive: true });
    writeFileSync(watchdogServicePath(), buildWatchdogService(execPath), 'utf8');
    writeFileSync(watchdogTimerPath(), buildWatchdogTimer(intervalSec), 'utf8');
    await runCmd(`systemctl --user daemon-reload`);
    await runCmd(`systemctl --user enable --now ${SERVICE_NAME}-watchdog.timer`);
  }

  async uninstallWatchdogTimer(): Promise<void> {
    const timerPath = watchdogTimerPath();
    const svcPath = watchdogServicePath();
    if (existsSync(timerPath)) {
      try { await runCmd(`systemctl --user stop ${SERVICE_NAME}-watchdog.timer`); } catch { /* ignore */ }
      try { await runCmd(`systemctl --user disable ${SERVICE_NAME}-watchdog.timer`); } catch { /* ignore */ }
      unlinkSync(timerPath);
    }
    if (existsSync(svcPath)) {
      unlinkSync(svcPath);
    }
    try { await runCmd(`systemctl --user daemon-reload`); } catch { /* ignore */ }
  }
}
