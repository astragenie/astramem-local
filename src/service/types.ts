export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  detail?: string;
}

/**
 * Discriminated union returned by ServiceAdapter.install().
 *
 * - `task`    — a scheduled task (schtasks) / systemd unit / launchd plist was
 *               created. `service start/stop/status` will work normally.
 * - `startup` — OS-level task creation failed; a Startup-folder shortcut was
 *               installed as fallback. `service start/stop` will NOT work.
 *               `path` is the absolute path to the shortcut file.
 */
export type InstallResult =
  | { kind: 'task' }
  | { kind: 'startup'; path: string };

export interface ServiceAdapter {
  readonly platform: 'linux' | 'darwin' | 'win32';
  /** Write unit file / plist / task. Does NOT start or enable. */
  install(execPath: string, port: number): Promise<InstallResult>;
  /** Remove unit file / plist / task. */
  uninstall(): Promise<void>;
  /** Start the service via the OS init system. */
  start(): Promise<void>;
  /** Stop the service via the OS init system. */
  stop(): Promise<void>;
  /** Query current status. */
  status(): Promise<ServiceStatus>;
  /**
   * Install a nightly backup timer (optional — invoked by
   * `service install --with-backup-timer`).
   *
   * @param execPath  Same exec path used for the main service.
   * @param keep      Number of backups to retain (forwarded to --keep).
   */
  installBackupTimer(execPath: string, keep: number): Promise<void>;
  /**
   * Remove the nightly backup timer installed by installBackupTimer().
   * No-op if the timer was never installed.
   */
  uninstallBackupTimer(): Promise<void>;
}
