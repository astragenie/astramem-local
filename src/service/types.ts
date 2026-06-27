export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  pid?: number;
  detail?: string;
}

export interface ServiceAdapter {
  readonly platform: 'linux' | 'darwin' | 'win32';
  /** Write unit file / plist / task. Does NOT start or enable. */
  install(execPath: string, port: number): Promise<void>;
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
